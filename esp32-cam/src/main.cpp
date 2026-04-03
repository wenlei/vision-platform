#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "esp_task_wdt.h"

// ── WiFi 配置 ──────────────────────────────────────���───────
const char* ssid     = "701";
const char* password = "11040109";

// ── 摄像头引脚（XIAO ESP32-S3 Sense）─────────────────────
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
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
#define LOG_SIZE 50
#define LOG_MSG_LEN 96

struct LogEntry {
    unsigned long ts;   // millis()
    char msg[LOG_MSG_LEN];
};

LogEntry logBuf[LOG_SIZE];
int logHead = 0;        // 下一条写入位置
int logCount = 0;       // 当前日志总数

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
WebServer server(80);
WiFiServer streamServer(81);

int wifiReconnects = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastStatusLog = 0;
unsigned long reconnectDelay = 1000;   // 递增重连间隔
bool wifiWasConnected = false;

// ── 启动原因 ──────────────────────────────────────────────
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

// ── /status（含诊断字段）──────────────────────────────────
void handleStatus() {
    sensor_t* s = esp_camera_sensor_get();
    int vf = 0, hm = 0;
    if (s) { vf = s->status.vflip; hm = s->status.hmirror; }

    String json = "{\"status\":\"ok\","
        "\"device\":\"XIAO ESP32-S3\","
        "\"device_name\":\"desk-cam-01\","
        "\"location\":\"study-desk\","
        "\"resolution\":\"640x480\","
        "\"vflip\":" + String(vf) + ","
        "\"hmirror\":" + String(hm) + ","
        "\"ip\":\"" + WiFi.localIP().toString() + "\","
        "\"mac\":\"" + WiFi.macAddress() + "\","
        "\"rssi\":" + String(WiFi.RSSI()) + ","
        "\"uptime_sec\":" + String(millis() / 1000) + ","
        "\"free_heap\":" + String(ESP.getFreeHeap()) + ","
        "\"wifi_reconnects\":" + String(wifiReconnects) + ","
        "\"boot_reason\":\"" + String(getResetReason()) + "\"}";
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

// ── /logs ─────────────────────────────────────────────────
void handleLogs() {
    bool clearAfter = server.hasArg("clear") && server.arg("clear") == "1";

    String json = "[";
    int start = (logCount < LOG_SIZE) ? 0 : logHead;
    for (int i = 0; i < logCount; i++) {
        int idx = (start + i) % LOG_SIZE;
        if (i > 0) json += ",";
        // 转义 msg 中的双引号
        String escaped = logBuf[idx].msg;
        escaped.replace("\"", "\\\"");
        json += "{\"t\":" + String(logBuf[idx].ts) + ",\"msg\":\"" + escaped + "\"}";
    }
    json += "]";

    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);

    if (clearAfter) {
        logHead = 0;
        logCount = 0;
    }
}

// ── /config?vflip=0|1&hmirror=0|1 ────────────────────────
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
        "\"vflip\":" + String(s->status.vflip) + ","
        "\"hmirror\":" + String(s->status.hmirror) + "}";
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

// ── /capture ──────────────────────────────────────────────
void handleCapture() {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        addLog("Capture failed");
        server.send(500, "application/json", "{\"error\":\"capture failed\"}");
        return;
    }
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("X-Device-MAC", WiFi.macAddress());
    server.sendHeader("X-Device-IP", WiFi.localIP().toString());
    server.sendHeader("X-Device-Name", "desk-cam-01");
    server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
    server.send_P(200, "image/jpeg", (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
}

// ── MJPEG stream :81 ─────────────────────────────────────
void handleStreamClient(WiFiClient client) {
    addLog("Stream client connected");
    client.print("HTTP/1.1 200 OK\r\n");
    client.print("Content-Type: multipart/x-mixed-replace; boundary=frame\r\n");
    client.print("Access-Control-Allow-Origin: *\r\n");
    client.print("Connection: keep-alive\r\n\r\n");

    while (client.connected()) {
        esp_task_wdt_reset();  // 喂狗，避免流阻塞触发看门狗
        camera_fb_t* fb = esp_camera_fb_get();
        if (!fb) { addLog("Stream capture failed"); break; }
        client.print("--frame\r\n");
        client.print("Content-Type: image/jpeg\r\n");
        client.print("Content-Length: " + String(fb->len) + "\r\n\r\n");
        client.write(fb->buf, fb->len);
        client.print("\r\n");
        esp_camera_fb_return(fb);
        delay(50);
    }
    client.stop();
    addLog("Stream client disconnected");
}

// ── WiFi 自动重连 ────────────────────────────────────────
void checkWifi() {
    unsigned long now = millis();
    if (now - lastWifiCheck < 1000) return;  // 每秒检查一次
    lastWifiCheck = now;

    if (WiFi.status() == WL_CONNECTED) {
        if (!wifiWasConnected) {
            addLog("WiFi connected IP=%s RSSI=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
            wifiWasConnected = true;
            reconnectDelay = 1000;  // 重置重连间隔
        }
        return;
    }

    // WiFi 断开
    if (wifiWasConnected) {
        addLog("WiFi disconnected after %lu sec", now / 1000);
        wifiWasConnected = false;
    }

    // 递增重连
    static unsigned long lastReconnectAttempt = 0;
    if (now - lastReconnectAttempt >= reconnectDelay) {
        lastReconnectAttempt = now;
        wifiReconnects++;
        addLog("WiFi reconnect #%d (delay=%lums)", wifiReconnects, reconnectDelay);
        WiFi.disconnect();
        WiFi.begin(ssid, password);
        if (reconnectDelay < 30000) reconnectDelay *= 2;  // 最大 30 秒
    }
}

// ── 定期状态日志（每 60 秒）──────────────────────────────
void periodicStatusLog() {
    unsigned long now = millis();
    if (now - lastStatusLog < 60000) return;
    lastStatusLog = now;
    addLog("RSSI=%d heap=%u uptime=%lus", WiFi.RSSI(), ESP.getFreeHeap(), now / 1000);
}

// ── setup ────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);

    addLog("Boot reason: %s", getResetReason());
    addLog("Connecting WiFi SSID=%s", ssid);

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
        while (true) delay(1000);
    }

    server.on("/status",  handleStatus);
    server.on("/capture", handleCapture);
    server.on("/config",  handleConfig);
    server.on("/logs",    handleLogs);
    server.begin();
    streamServer.begin();

    // 启用看门狗（8 秒超时）
    esp_task_wdt_init(8, true);
    esp_task_wdt_add(NULL);

    addLog("Ready: :80/status,capture,config,logs :81/stream");
}

// ── loop ─────────────────────────────────────────────────
void loop() {
    esp_task_wdt_reset();
    checkWifi();
    periodicStatusLog();

    if (WiFi.status() == WL_CONNECTED) {
        server.handleClient();
        WiFiClient streamClient = streamServer.available();
        if (streamClient) {
            handleStreamClient(streamClient);
        }
    }
}
