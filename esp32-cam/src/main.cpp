#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "esp_task_wdt.h"
#include "secrets.h"          // WIFI_SSID, WIFI_PASSWORD (git-ignored)

// ── WiFi 配置 ──────────────────────────────────────────────
// 实际 SSID/密码定义在 secrets.h（不进 Git）
const char* ssid     = WIFI_SSID;
const char* password = WIFI_PASSWORD;

// ── 摄像头引脚（XIAO ESP32-S3 Sense）─────────────────────
// 引脚编号固定对应 Seeed XIAO ESP32-S3 Sense 板载摄像头接口
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40   // SCCB SDA（I2C 数据）
#define SIOC_GPIO_NUM  39   // SCCB SCL（I2C 时钟）
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

// ── 环形日志缓冲区 ────────────────────────────────────────
// 使用固定大小的环形缓冲区存储最近 LOG_SIZE 条日志，
// 避免动态内存分配，防止堆碎片。
#define LOG_SIZE 50         // 最多保留 50 条日志
#define LOG_MSG_LEN 96      // 每条日志最长 96 字节

struct LogEntry {
    unsigned long ts;       // 时间戳（millis()）
    char msg[LOG_MSG_LEN];  // 日志内容
};

LogEntry logBuf[LOG_SIZE];
int logHead  = 0;   // 下一条写入位置（循环覆盖）
int logCount = 0;   // 当前已记录的日志总数（上限 LOG_SIZE）

// addLog：格式化写入环形缓冲区，同时输出到串口
void addLog(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    LogEntry& e = logBuf[logHead];
    e.ts = millis();
    vsnprintf(e.msg, LOG_MSG_LEN, fmt, args);
    va_end(args);
    Serial.printf("[%lu] %s\n", e.ts, e.msg);
    logHead = (logHead + 1) % LOG_SIZE;
    if (logCount < LOG_SIZE) logCount++;
}

// ── 全局状态 ──────────────────────────────────────────────
WebServer server(80);       // REST API 服务（/status /capture /config /logs）
WiFiServer streamServer(81);// MJPEG 视频流服务（独立端口，避免阻塞主循环）

int wifiReconnects      = 0;       // WiFi 断线重连次数（上报至 /status）
unsigned long lastWifiCheck  = 0;  // 上次 WiFi 状态检查时间
unsigned long lastStatusLog  = 0;  // 上次定期状态日志时间
unsigned long reconnectDelay = 1000; // 重连间隔（递增，最大 30s）
bool wifiWasConnected = false;     // 上一轮 WiFi 是否已连接（用于检测断线事件）

// ── 启动原因 ──────────────────────────────────────────────
// 将 ESP32 硬件重启原因枚举转为可读字符串，用于 /status 接口诊断
const char* getResetReason() {
    esp_reset_reason_t r = esp_reset_reason();
    switch (r) {
        case ESP_RST_POWERON:  return "power_on";
        case ESP_RST_SW:       return "software";
        case ESP_RST_PANIC:    return "crash_panic";
        case ESP_RST_INT_WDT:  return "int_watchdog";
        case ESP_RST_TASK_WDT: return "task_watchdog";
        case ESP_RST_WDT:      return "watchdog";
        case ESP_RST_DEEPSLEEP: return "deep_sleep";
        case ESP_RST_BROWNOUT: return "brownout";
        default:               return "unknown";
    }
}

// ── 摄像头初始化 ──────────────────────────────────────────
// 配置摄像头参数并调用 esp_camera_init()。
// 分辨率 VGA 640x480，JPEG 质量 10（较高压缩，适合网络传输）。
// 使用 PSRAM 帧缓冲（fb_location = CAMERA_FB_IN_PSRAM），
// CAMERA_GRAB_LATEST 保证每次 esp_camera_fb_get() 拿到最新帧。
bool initCamera() {
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0       = Y2_GPIO_NUM;
    config.pin_d1       = Y3_GPIO_NUM;
    config.pin_d2       = Y4_GPIO_NUM;
    config.pin_d3       = Y5_GPIO_NUM;
    config.pin_d4       = Y6_GPIO_NUM;
    config.pin_d5       = Y7_GPIO_NUM;
    config.pin_d6       = Y8_GPIO_NUM;
    config.pin_d7       = Y9_GPIO_NUM;
    config.pin_xclk     = XCLK_GPIO_NUM;
    config.pin_pclk     = PCLK_GPIO_NUM;
    config.pin_vsync    = VSYNC_GPIO_NUM;
    config.pin_href     = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn     = PWDN_GPIO_NUM;
    config.pin_reset    = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.frame_size   = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
    config.grab_mode    = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        addLog("Camera init failed: 0x%x", err);
        return false;
    }
    addLog("Camera ready VGA 640x480");
    return true;
}

// ── GET /status ───────────────────────────────────────────
// 返回设备基础信息与实时诊断字段（JSON）。
// 后端通过此接口判断设备在线状态，device_layer.py 通过 MAC 映射设备名。
//
// 注意：device_name / location 字段由后端（devices 表）维护，
// 固件只上报 MAC，不做任何业务映射。
void handleStatus() {
    sensor_t* s = esp_camera_sensor_get();
    int vf = 0, hm = 0;
    if (s) { vf = s->status.vflip; hm = s->status.hmirror; }

    String json = "{\"status\":\"ok\","
        "\"device\":\"XIAO ESP32-S3\","
        "\"device_name\":\"desk-cam-01\","  // 仅作标识，正式映射在后端
        "\"location\":\"study-desk\","
        "\"resolution\":\"640x480\","
        "\"vflip\":"    + String(vf) + ","
        "\"hmirror\":"  + String(hm) + ","
        "\"ip\":\""     + WiFi.localIP().toString() + "\","
        "\"mac\":\""    + WiFi.macAddress() + "\","
        "\"rssi\":"     + String(WiFi.RSSI()) + ","
        "\"uptime_sec\":" + String(millis() / 1000) + ","
        "\"free_heap\":" + String(ESP.getFreeHeap()) + ","
        "\"wifi_reconnects\":" + String(wifiReconnects) + ","
        "\"boot_reason\":\"" + String(getResetReason()) + "\"}";
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

// ── GET /logs ─────────────────────────────────────────────
// 返回环形缓冲区中的所有日志条目（JSON 数组）。
// 支持 ?clear=1 查询参数：返回后立即清空缓冲区。
void handleLogs() {
    bool clearAfter = server.hasArg("clear") && server.arg("clear") == "1";

    String json = "[";
    // 从最旧的一条开始遍历，保证时间顺序
    int start = (logCount < LOG_SIZE) ? 0 : logHead;
    for (int i = 0; i < logCount; i++) {
        int idx = (start + i) % LOG_SIZE;
        if (i > 0) json += ",";
        // 转义 msg 中的双引号，确保 JSON 合法
        String escaped = logBuf[idx].msg;
        escaped.replace("\"", "\\\"");
        json += "{\"t\":" + String(logBuf[idx].ts) + ",\"msg\":\"" + escaped + "\"}";
    }
    json += "]";

    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);

    if (clearAfter) {
        logHead  = 0;
        logCount = 0;
    }
}

// ── POST /config?vflip=0|1&hmirror=0|1 ───────────────────
// 动态调整摄像头方向，直接写入传感器寄存器，立即对所有后续帧生效。
// vflip=1：垂直翻转；hmirror=1：水平镜像。
// 可组合使用，不影响 MJPEG 流的连续性。
void handleConfig() {
    sensor_t* s = esp_camera_sensor_get();
    if (!s) {
        server.send(500, "application/json", "{\"error\":\"sensor not ready\"}");
        return;
    }
    if (server.hasArg("vflip")) {
        int v = server.arg("vflip").toInt();
        s->set_vflip(s, v);
        addLog("Config vflip=%d", v);
    }
    if (server.hasArg("hmirror")) {
        int h = server.arg("hmirror").toInt();
        s->set_hmirror(s, h);
        addLog("Config hmirror=%d", h);
    }
    String json = "{\"status\":\"ok\","
        "\"vflip\":"   + String(s->status.vflip) + ","
        "\"hmirror\":" + String(s->status.hmirror) + "}";
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

// ── POST /capture ─────────────────────────────────────────
// 拍摄一帧 JPEG 图片并以 HTTP 响应直接返回图片内容。
// 在 HTTP header 中携带设备 MAC（X-Device-MAC）和 IP（X-Device-IP），
// 后端推理服务通过 X-Device-MAC 识别设备身份，无需 ESP32 上报设备名。
void handleCapture() {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        addLog("Capture failed");
        server.send(500, "application/json", "{\"error\":\"capture failed\"}");
        return;
    }
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("X-Device-MAC",          WiFi.macAddress());
    server.sendHeader("X-Device-IP",           WiFi.localIP().toString());
    server.sendHeader("X-Device-Name",         "desk-cam-01");
    server.sendHeader("Content-Disposition",   "inline; filename=capture.jpg");
    server.send_P(200, "image/jpeg", (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
}

// ── MJPEG stream :81 ──────────────────────────────────────
// 处理单个 MJPEG 流客户端连接，持续推送帧直到客户端断开。
// 使用 multipart/x-mixed-replace 边界协议，浏览器原生支持。
// 帧间隔 50ms（约 20fps），每帧推送后调用 esp_task_wdt_reset()
// 防止看门狗超时。
//
// 注意：此函数为阻塞循环，同一时刻只能服务一个流客户端。
// 流客户端连接期间 :80 接口响应可能延迟。
void handleStreamClient(WiFiClient client) {
    addLog("Stream client connected");
    client.print("HTTP/1.1 200 OK\r\n");
    client.print("Content-Type: multipart/x-mixed-replace; boundary=frame\r\n");
    client.print("Access-Control-Allow-Origin: *\r\n");
    client.print("Connection: keep-alive\r\n\r\n");

    while (client.connected()) {
        esp_task_wdt_reset();  // 喂狗，防止流阻塞触发看门狗重启
        camera_fb_t* fb = esp_camera_fb_get();
        if (!fb) { addLog("Stream capture failed"); break; }
        client.print("--frame\r\n");
        client.print("Content-Type: image/jpeg\r\n");
        client.print("Content-Length: " + String(fb->len) + "\r\n\r\n");
        client.write(fb->buf, fb->len);
        client.print("\r\n");
        esp_camera_fb_return(fb);
        delay(50);  // 控制帧率约 20fps
    }
    client.stop();
    addLog("Stream client disconnected");
}

// ── WiFi 自动重连 ─────────────────────────────────────────
// 每秒检查一次 WiFi 状态。断线后以递增间隔（1s→2s→4s…最大 30s）
// 尝试重连，避免频繁重连消耗资源。重连次数记录在 wifiReconnects，
// 可通过 /status 查看历史断线次数。
void checkWifi() {
    unsigned long now = millis();
    if (now - lastWifiCheck < 1000) return;
    lastWifiCheck = now;

    if (WiFi.status() == WL_CONNECTED) {
        if (!wifiWasConnected) {
            addLog("WiFi connected IP=%s RSSI=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
            wifiWasConnected = true;
            reconnectDelay = 1000;  // 恢复连接后重置重连间隔
        }
        return;
    }

    // 刚断线：记录日志，重置连接状态标志
    if (wifiWasConnected) {
        addLog("WiFi disconnected after %lu sec", now / 1000);
        wifiWasConnected = false;
    }

    // 按递增间隔尝试重连
    static unsigned long lastReconnectAttempt = 0;
    if (now - lastReconnectAttempt >= reconnectDelay) {
        lastReconnectAttempt = now;
        wifiReconnects++;
        addLog("WiFi reconnect #%d (delay=%lums)", wifiReconnects, reconnectDelay);
        WiFi.disconnect();
        WiFi.begin(ssid, password);
        if (reconnectDelay < 30000) reconnectDelay *= 2;  // 指数退避，上限 30s
    }
}

// ── 定期状态日志（每 60 秒）──────────────────────────────
// 每分钟自动记录一次 RSSI、可用堆内存、运行时长，
// 便于通过 /logs 接口远程判断设备稳定性。
void periodicStatusLog() {
    unsigned long now = millis();
    if (now - lastStatusLog < 60000) return;
    lastStatusLog = now;
    addLog("RSSI=%d heap=%u uptime=%lus", WiFi.RSSI(), ESP.getFreeHeap(), now / 1000);
}

// ── setup ─────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);

    addLog("Boot reason: %s", getResetReason());
    addLog("Connecting WiFi SSID=%s", ssid);

    // 初始连接，超时 15s 后继续（checkWifi() 在 loop 中持续重试）
    WiFi.begin(ssid, password);
    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 15000) {
        delay(500);
        Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        wifiWasConnected = true;
        addLog("WiFi connected IP=%s RSSI=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        addLog("WiFi initial connect timeout, will retry in loop");
    }

    if (!initCamera()) {
        addLog("Camera init failed - halting");
        while (true) delay(1000);  // 摄像头初始化失败则停机，等待看门狗重启
    }

    // 注册 REST 接口
    server.on("/status",  handleStatus);
    server.on("/capture", handleCapture);
    server.on("/config",  handleConfig);
    server.on("/logs",    handleLogs);
    server.begin();

    // 启动 MJPEG 流服务（独立端口 :81）
    streamServer.begin();

    // 启用任务看门狗（8 秒超时），防止主循环卡死
    esp_task_wdt_init(8, true);
    esp_task_wdt_add(NULL);

    addLog("Ready: :80/status,capture,config,logs :81/stream");
}

// ── loop ──────────────────────────────────────────────────
void loop() {
    esp_task_wdt_reset();   // 每轮喂狗
    checkWifi();            // WiFi 断线自动重连
    periodicStatusLog();    // 每分钟记录状态日志

    if (WiFi.status() == WL_CONNECTED) {
        server.handleClient();  // 处理 :80 REST 请求

        // 检查是否有 MJPEG 流客户端接入
        WiFiClient streamClient = streamServer.available();
        if (streamClient) {
            handleStreamClient(streamClient);  // 阻塞直到客户端断开
        }
    }
}
