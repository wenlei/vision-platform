#include <math.h>
/**
 * esp32-audio — XIAO ESP32S3 Sense 语音交互固件
 * 接线: MAX98357A LRC=GPIO7, BCLK=GPIO8, DIN=GPIO9, SD=3V3, GND=GND, VIN=VUSB
 * 麦克风: 内置 PDM GPIO42(CLK) GPIO41(DATA)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <HTTPClient.h>
#include <driver/i2s.h>
#include "secrets.h"

// ── 引脚 ──────────────────────────────────────────────────
#define PIN_BUTTON      0
#define I2S_MIC_CLK     42
#define I2S_MIC_DATA    41
#define I2S_SPK_BCLK    3       // MAX98357A BCLK (XIAO D2=GPIO3)
#define I2S_SPK_LRC     4       // MAX98357A LRC  (XIAO D3=GPIO4)
#define I2S_SPK_DOUT    2       // MAX98357A DIN  (XIAO D1=GPIO2)

// ── 音频参数 ──────────────────────────────────────────────
#define SAMPLE_RATE     16000
#define RECORD_SECONDS  5
#define BUF_SIZE        (SAMPLE_RATE * RECORD_SECONDS * 2)

#define I2S_MIC_PORT    I2S_NUM_0
#define I2S_SPK_PORT    I2S_NUM_1

// ── 全局变量 ──────────────────────────────────────────────
AsyncWebServer server(80);
int8_t* audioBuf = nullptr;
volatile bool recording = false;
volatile bool playing   = false;
volatile bool recordTriggered = false;
String deviceIP = "";

// ── I2S 麦克风 ────────────────────────────────────────────
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
        .ws_io_num  = I2S_MIC_CLK,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num  = I2S_MIC_DATA,
    };
    i2s_driver_install(I2S_MIC_PORT, &cfg, 0, NULL);
    i2s_set_pin(I2S_MIC_PORT, &pins);
    i2s_zero_dma_buffer(I2S_MIC_PORT);
    Serial.println("[MIC] OK");
}

// ── I2S 扬声器 ────────────────────────────────────────────
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
        .ws_io_num  = I2S_SPK_LRC,
        .data_out_num = I2S_SPK_DOUT,
        .data_in_num  = I2S_PIN_NO_CHANGE,
    };
    i2s_driver_install(I2S_SPK_PORT, &cfg, 0, NULL);
    i2s_set_pin(I2S_SPK_PORT, &pins);
    i2s_zero_dma_buffer(I2S_SPK_PORT);
    Serial.println("[SPK] OK");
}

// ── 播放 PCM ──────────────────────────────────────────────
void playPCM(const uint8_t* data, size_t len) {
    playing = true;
    size_t written = 0;
    size_t offset = 0;
    while (offset < len) {
        size_t chunk = min((size_t)1024, len - offset);
        i2s_write(I2S_SPK_PORT, data + offset, chunk, &written, portMAX_DELAY);
        offset += written;
    }
    playing = false;
    Serial.printf("[SPK] 播放完成 %d bytes\n", len);
}

// ── 录音 ──────────────────────────────────────────────────
size_t recordAudio() {
    Serial.println("[REC] 开始...");
    size_t bytesRead = 0, total = 0;
    while (total < BUF_SIZE) {
        i2s_read(I2S_MIC_PORT, audioBuf + total,
                 min((size_t)1024, BUF_SIZE - total), &bytesRead, 100);
        total += bytesRead;
    }
    Serial.printf("[REC] 完成 %d bytes\n", total);
    return total;
}

// ── 发送音频到服务器 ──────────────────────────────────────
void sendAudio(size_t len) {
    HTTPClient http;
    String url = String("http://") + SERVER_HOST + "/audio/infer";
    http.begin(url);
    http.addHeader("Content-Type", "audio/pcm");
    http.addHeader("X-Sample-Rate", String(SAMPLE_RATE));
    http.addHeader("X-Device", "desk-audio-03");
    int code = http.POST((uint8_t*)audioBuf, len);
    Serial.printf("[NET] HTTP %d\n", code);
    if (code == 200) {
        int respLen = http.getSize();
        uint8_t* respBuf = (uint8_t*)ps_malloc(respLen);
        if (respBuf) {
            WiFiClient* stream = http.getStreamPtr();
            stream->readBytes(respBuf, respLen);
            playPCM(respBuf, respLen);
            free(respBuf);
        }
    }
    http.end();
}

// ── Wi-Fi ─────────────────────────────────────────────────
void wifiConnect() {
    IPAddress localIP(192, 168, 50, 99);
    IPAddress gateway(192, 168, 50, 1);
    IPAddress subnet(255, 255, 255, 0);
    WiFi.config(localIP, gateway, subnet, gateway);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    int retry = 0;
    while (WiFi.status() != WL_CONNECTED && retry++ < 30)
        delay(500);
    if (WiFi.status() == WL_CONNECTED) {
        deviceIP = WiFi.localIP().toString();
        Serial.printf("[WIFI] IP: %s\n", deviceIP.c_str());
    } else {
        ESP.restart();
    }
}

// ── setup ─────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("[BOOT] esp32-audio");

    pinMode(PIN_BUTTON, INPUT_PULLUP);
    audioBuf = (int8_t*)ps_malloc(BUF_SIZE);
    if (!audioBuf) audioBuf = (int8_t*)malloc(BUF_SIZE);

    wifiConnect();
    micInit();
    spkInit();
    server.onRequestBody([](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total){
        if (req->url() == "/speak") {
            if (index == 0) {
                Serial.printf("[SPK] 接收音频 total=%d\n", total);
                playing = true;
                i2s_zero_dma_buffer(I2S_SPK_PORT);
            }
            size_t written = 0;
            i2s_write(I2S_SPK_PORT, data, len, &written, portMAX_DELAY);
            if (index + len >= total) {
                playing = false;
                Serial.println("[SPK] 播放完成");
            }
        }
    });

    // GET /status
    server.on("/status", HTTP_GET, [](AsyncWebServerRequest* req) {
        String json = "{";
        json += "\"device\":\"desk-audio-03\",";
        json += "\"ip\":\"" + deviceIP + "\",";
        json += "\"mac\":\"" + WiFi.macAddress() + "\",";
        json += "\"recording\":" + String(recording ? "true" : "false") + ",";
        json += "\"playing\":" + String(playing ? "true" : "false") + ",";
        json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
        json += "\"free_heap\":" + String(ESP.getFreeHeap());
        json += "}";
        req->send(200, "application/json", json);
    });

    // POST /record — 触发录音
    server.on("/record", HTTP_POST, [](AsyncWebServerRequest* req) {
        if (recording || playing) {
            req->send(503, "application/json", "{\"error\":\"busy\"}");
            return;
        }
        recordTriggered = true;
        req->send(200, "application/json", "{\"status\":\"recording_started\"}");
    });

    // POST /speak — 接收 raw PCM 并播放
    AsyncCallbackWebHandler* speakHandler = new AsyncCallbackWebHandler();
    speakHandler->setUri("/speak");
    speakHandler->setMethod(HTTP_POST);

    // body 接收完成时播放
    speakHandler->onRequest([](AsyncWebServerRequest* req) {
        req->send(200, "application/json", "{\"status\":\"ok\"}");
    });

    speakHandler->onBody([](AsyncWebServerRequest* req,
                            uint8_t* data, size_t len,
                            size_t index, size_t total) {
        if (index == 0) {
            Serial.printf("[SPK] 接收音频 total=%d\n", total);
            playing = true;
            i2s_zero_dma_buffer(I2S_SPK_PORT);
        }
        size_t written = 0;
        i2s_write(I2S_SPK_PORT, data, len, &written, portMAX_DELAY);
        if (index + len >= total) {
            playing = false;
            Serial.println("[SPK] 播放完成");
        }
    });

    server.addHandler(speakHandler);
    server.begin();
    Serial.println("[HTTP] 启动，等待指令...");

    // 开机播放测试音（440Hz 正弦波 1秒）
    Serial.println("[TEST] 播放开机测试音...");
    const int testSamples = 16000;
    int16_t* testBuf = (int16_t*)malloc(testSamples * 2);
    if (testBuf) {
        for (int i = 0; i < testSamples; i++) {
            testBuf[i] = (int16_t)(10000 * sin(2.0 * PI * 440.0 * i / 16000.0));
        }
        size_t written = 0;
        i2s_write(I2S_SPK_PORT, testBuf, testSamples * 2, &written, portMAX_DELAY);
        free(testBuf);
        Serial.printf("[TEST] 写入 %d bytes\n", written);
    }
}

// ── loop ──────────────────────────────────────────────────
void loop() {
    if ((recordTriggered || digitalRead(PIN_BUTTON) == LOW) && !recording && !playing) {
        if (!recordTriggered) {
            delay(50);
            if (digitalRead(PIN_BUTTON) != LOW) return;
        }
        recordTriggered = false;
        recording = true;
        size_t len = recordAudio();
        recording = false;
        sendAudio(len);
    }
}
