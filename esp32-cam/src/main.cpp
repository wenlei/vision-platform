#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"

const char* ssid     = "701";
const char* password = "11040109";

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

WebServer server(80);
WiFiServer streamServer(81);

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
        Serial.printf("Camera init failed: 0x%x", err);
        return false;
    }
    Serial.println("Camera ready - VGA 640x480");
    return true;
}

// ── /status ────────────────────────────────────────────────
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
                  "\"mac\":\"" + WiFi.macAddress() + "\"}";
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

// ── /config?vflip=0|1&hmirror=0|1 ─────────────────────────
void handleConfig() {
    sensor_t* s = esp_camera_sensor_get();
    if (!s) {
        server.send(500, "application/json", "{\"error\":\"sensor not ready\"}");
        return;
    }

    String changed = "";

    if (server.hasArg("vflip")) {
        int v = server.arg("vflip").toInt();
        s->set_vflip(s, v);
        changed += "vflip=" + String(v) + " ";
    }
    if (server.hasArg("hmirror")) {
        int h = server.arg("hmirror").toInt();
        s->set_hmirror(s, h);
        changed += "hmirror=" + String(h) + " ";
    }

    Serial.println("Config updated: " + changed);

    String json = "{\"status\":\"ok\","
                  "\"vflip\":" + String(s->status.vflip) + ","
                  "\"hmirror\":" + String(s->status.hmirror) + "}";
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

// ── /capture ───────────────────────────────────────────────
void handleCapture() {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
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
    Serial.println("Captured VGA frame");
}

// ── MJPEG stream :81 ───────────────────────────────────────
void handleStreamClient(WiFiClient client) {
    Serial.println("Stream client connected");
    client.print("HTTP/1.1 200 OK\r\n");
    client.print("Content-Type: multipart/x-mixed-replace; boundary=frame\r\n");
    client.print("Access-Control-Allow-Origin: *\r\n");
    client.print("Connection: keep-alive\r\n\r\n");

    while (client.connected()) {
        camera_fb_t* fb = esp_camera_fb_get();
        if (!fb) { Serial.println("Stream: capture failed"); break; }

        client.print("--frame\r\n");
        client.print("Content-Type: image/jpeg\r\n");
        client.print("Content-Length: " + String(fb->len) + "\r\n\r\n");
        client.write(fb->buf, fb->len);
        client.print("\r\n");
        esp_camera_fb_return(fb);
        delay(50);
    }
    client.stop();
    Serial.println("Stream client disconnected");
}

// ── setup / loop ───────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("Connecting WiFi...");
    WiFi.begin(ssid, password);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500); Serial.print(".");
    }
    Serial.println("");
    Serial.print("IP: ");    Serial.println(WiFi.localIP());
    Serial.print("MAC: ");   Serial.println(WiFi.macAddress());

    if (!initCamera()) {
        Serial.println("Camera init failed - halting");
        while(true) delay(1000);
    }

    server.on("/status",  handleStatus);
    server.on("/capture", handleCapture);
    server.on("/config",  handleConfig);
    server.begin();
    streamServer.begin();

    Serial.println("Endpoints:");
    Serial.println("  :80/status          - device info + current orientation");
    Serial.println("  :80/capture         - single JPEG");
    Serial.println("  :80/config?vflip=1  - set vflip (0/1)");
    Serial.println("  :80/config?hmirror=1- set hmirror (0/1)");
    Serial.println("  :81/               - MJPEG stream");
}

void loop() {
    server.handleClient();
    WiFiClient streamClient = streamServer.available();
    if (streamClient) {
        handleStreamClient(streamClient);
    }
}
