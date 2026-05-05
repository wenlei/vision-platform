/**
 * esp32-audio — XIAO ESP32S3 Sense 语音交互固件
 * 
 * 功能：
 *   - 按键触发录音（BOOT 按钮，GPIO0）
 *   - PDM 麦克风采集（GPIO41/42）
 *   - Wi-Fi 传输音频到 Win 服务器
 *   - I2S 播放服务器返回的音频（MAX98357A，GPIO7/8/9）
 *   - HTTP 状态接口 /status
 * 
 * 接线：
 *   MAX98357A: LRC=D7, BCLK=D8, DIN=D9, SD=3V3, GND=GND, VIN=VUSB
 *   麦克风: 内置 PDM（GPIO41 CLK, GPIO42 DATA）
 *   按键: BOOT（GPIO0，低电平触发）
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <driver/i2s.h>

#include "secrets.h"  // WIFI_SSID, WIFI_PASSWORD, SERVER_HOST

// ── 引脚定义 ──────────────────────────────────────────────
#define PIN_BUTTON      0       // BOOT 按键
#define I2S_MIC_CLK     42      // PDM 麦克风时钟
#define I2S_MIC_DATA    41      // PDM 麦克风数据
#define I2S_SPK_BCLK    8       // MAX98357A BCLK
#define I2S_SPK_LRC     7       // MAX98357A LRC
#define I2S_SPK_DOUT    9       // MAX98357A DIN

// ── 音频参数 ──────────────────────────────────────────────
#define SAMPLE_RATE     16000
#define SAMPLE_BITS     16
#define RECORD_SECONDS  5
#define BUF_SIZE        (SAMPLE_RATE * RECORD_SECONDS * 2)  // 16bit = 2 bytes

// ── I2S 端口 ──────────────────────────────────────────────
#define I2S_MIC_PORT    I2S_NUM_0
#define I2S_SPK_PORT    I2S_NUM_1

// ── 全局变量 ──────────────────────────────────────────────
WebServer server(80);
int8_t* audioBuf = nullptr;
volatile bool recording = false;
volatile bool playing = false;
volatile bool recordTriggered = false;
String deviceIP = "";

// ── 麦克风初始化 ──────────────────────────────────────────
void micInit() {
    i2s_config_t cfg = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_PCM_SHORT,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 512,
        .use_apll = false,
    };
    i2s_pin_config_t pins = {
        .mck_io_num = I2S_PIN_NO_CHANGE,
        .bck_io_num = I2S_PIN_NO_CHANGE,
        .ws_io_num = I2S_MIC_CLK,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = I2S_MIC_DATA,
    };
    i2s_driver_install(I2S_MIC_PORT, &cfg, 0, NULL);
    i2s_set_pin(I2S_MIC_PORT, &pins);
    i2s_zero_dma_buffer(I2S_MIC_PORT);
    Serial.println("[MIC] 初始化完成");
}

// ── 扬声器初始化 ──────────────────────────────────────────
void spkInit() {
    i2s_config_t cfg = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 512,
        .use_apll = false,
        .tx_desc_auto_clear = true,
    };
    i2s_pin_config_t pins = {
        .mck_io_num = I2S_PIN_NO_CHANGE,
        .bck_io_num = I2S_SPK_BCLK,
        .ws_io_num = I2S_SPK_LRC,
        .data_out_num = I2S_SPK_DOUT,
        .data_in_num = I2S_PIN_NO_CHANGE,
    };
    i2s_driver_install(I2S_SPK_PORT, &cfg, 0, NULL);
    i2s_set_pin(I2S_SPK_PORT, &pins);
    i2s_zero_dma_buffer(I2S_SPK_PORT);
    Serial.println("[SPK] 初始化完成");
}

// ── 录音 ──────────────────────────────────────────────────
size_t recordAudio() {
    Serial.println("[REC] 开始录音...");
    size_t bytesRead = 0;
    size_t total = 0;
    size_t target = BUF_SIZE;

    while (total < target) {
        i2s_read(I2S_MIC_PORT, audioBuf + total, 
                 min((size_t)1024, target - total), &bytesRead, 100);
        total += bytesRead;
    }
    Serial.printf("[REC] 录音完成，%d bytes\n", total);
    return total;
}

// ── 发送音频到服务器 ──────────────────────────────────────
void sendAudio(size_t len) {
    Serial.printf("[NET] 发送音频到 %s...\n", SERVER_HOST);
    HTTPClient http;
    String url = String("http://") + SERVER_HOST + "/audio/infer";
    http.begin(url);
    http.addHeader("Content-Type", "audio/pcm");
    http.addHeader("X-Sample-Rate", String(SAMPLE_RATE));
    http.addHeader("X-Device", "desk-audio-03");

    int code = http.POST((uint8_t*)audioBuf, len);
    Serial.printf("[NET] HTTP %d\n", code);

    if (code == 200) {
        // 接收返回的 PCM 音频并播放
        WiFiClient* stream = http.getStreamPtr();
        int payloadLen = http.getSize();
        Serial.printf("[NET] 收到音频响应 %d bytes\n", payloadLen);

        playing = true;
        uint8_t tmpBuf[512];
        size_t written = 0;
        while (http.connected() && payloadLen > 0) {
            size_t avail = stream->available();
            if (avail) {
                size_t toRead = min((size_t)512, (size_t)payloadLen);
                size_t rd = stream->readBytes(tmpBuf, toRead);
                i2s_write(I2S_SPK_PORT, tmpBuf, rd, &written, 100);
                payloadLen -= rd;
            }
        }
        playing = false;
        Serial.println("[SPK] 播放完成");
    } else {
        Serial.println("[NET] 请求失败");
    }
    http.end();
}

// ── HTTP /status ──────────────────────────────────────────
void handleStatus() {
    String json = "{";
    json += "\"device\":\"desk-audio-03\",";
    json += "\"platform\":\"desk-platform\",";
    json += "\"mac\":\"" + WiFi.macAddress() + "\",";
    json += "\"ip\":\"" + deviceIP + "\",";
    json += "\"recording\":" + String(recording ? "true" : "false") + ",";
    json += "\"playing\":" + String(playing ? "true" : "false") + ",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    json += "\"free_heap\":" + String(ESP.getFreeHeap());
    json += "}";
    server.send(200, "application/json", json);
}

// ── POST /record ──────────────────────────────────────────
// HTTP 远程触发录音，替代 BOOT 物理按键。
// 返回 200 表示录音已启动，实际录音在 loop() 中异步执行。
void handleRecord() {
    if (recording || playing) {
        server.send(503, "application/json", "{\"error\":\"busy\",\"recording\":" + String(recording ? "true" : "false") + ",\"playing\":" + String(playing ? "true" : "false") + "}");
        return;
    }
    recordTriggered = true;
    Serial.println("[HTTP] 远程触发录音");
    server.send(200, "application/json", "{\"status\":\"recording_started\"}");
}

// ── POST /speak ──────────────────────────────────────────
// 接收服务器推送的音频数据并通过 I2S 扬声器播放。
// 使用 POST body 发送原始 PCM 数据，Content-Type: application/octet-stream
void handleSpeak() {
    if (playing) {
        server.send(503, "application/json", "{\"error\":\"busy\"}");
        return;
    }
    // 从请求体读取数据
    String body = server.arg("plain");
    if (body.length() == 0) {
        server.send(400, "application/json", "{\"error\":\"no audio data\"}");
        return;
    }
    int payloadLen = body.length();
    Serial.printf("[SPK] 收到音频 %d bytes，开始播放...\n", payloadLen);

    // 播放
    playing = true;
    const uint8_t* data = (const uint8_t*)body.c_str();
    size_t written = 0;
    size_t offset = 0;
    while (offset < (size_t)payloadLen) {
        size_t chunk = min((size_t)512, (size_t)payloadLen - offset);
        i2s_write(I2S_SPK_PORT, data + offset, chunk, &written, 100);
        offset += written;
    }
    playing = false;
    Serial.printf("[SPK] 播放完成，%d bytes\n", payloadLen);
    server.send(200, "application/json", "{\"status\":\"played\",\"bytes\":" + String(payloadLen) + "}");
}

// ── Wi-Fi 连接 ────────────────────────────────────────────
void wifiConnect() {
    IPAddress localIP(192, 168, 50, 99);
    IPAddress gateway(192, 168, 50, 1);
    IPAddress subnet(255, 255, 255, 0);
    IPAddress dns(192, 168, 50, 1);
    WiFi.config(localIP, gateway, subnet, dns);

    Serial.printf("[WIFI] 连接 %s...\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    int retry = 0;
    while (WiFi.status() != WL_CONNECTED && retry < 30) {
        delay(500);
        Serial.print(".");
        retry++;
    }
    if (WiFi.status() == WL_CONNECTED) {
        deviceIP = WiFi.localIP().toString();
        Serial.printf("\n[WIFI] 连接成功 IP: %s\n", deviceIP.c_str());
    } else {
        Serial.println("\n[WIFI] 连接失败，重启...");
        ESP.restart();
    }
}

// ── setup ─────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n[BOOT] esp32-audio 启动");

    pinMode(PIN_BUTTON, INPUT_PULLUP);

    // 分配音频缓冲区（PSRAM）
    audioBuf = (int8_t*)ps_malloc(BUF_SIZE);
    if (!audioBuf) {
        Serial.println("[ERROR] PSRAM 分配失败，使用 SRAM");
        audioBuf = (int8_t*)malloc(BUF_SIZE);
    }

    wifiConnect();
    micInit();
    spkInit();

    server.on("/status", handleStatus);
    server.on("/record", HTTP_POST, handleRecord);
    server.on("/speak", HTTP_POST, handleSpeak);
    server.begin();
    Serial.println("[HTTP] 服务器启动");
    Serial.println("[READY] 按 BOOT 键开始录音");
}

// ── loop ──────────────────────────────────────────────────
void loop() {
    server.handleClient();

    // 远程触发录音（HTTP /record）或物理按键触发
    if ((recordTriggered || digitalRead(PIN_BUTTON) == LOW) && !recording && !playing) {
        if (recordTriggered) {
            recordTriggered = false;
            Serial.println("[HTTP] 远程录音开始");
        } else {
            delay(50);  // 消抖
            if (digitalRead(PIN_BUTTON) != LOW) return;
            Serial.println("[BTN] 按键触发");
        }
        recording = true;
        size_t len = recordAudio();
        recording = false;
        sendAudio(len);
    }
}
