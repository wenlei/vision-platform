-- =============================================================
-- vision_db  init_db.sql
-- 所有建表语句使用 IF NOT EXISTS，幂等可重复执行。
-- 依赖：pgvector 扩展（提供 vector 类型与向量索引）
-- 执行方式：psql -U wenlei -d vision_db -f init_db.sql
-- =============================================================

-- pgvector 扩展：提供 vector 类型、余弦/L2 距离运算符、ivfflat 索引
CREATE EXTENSION IF NOT EXISTS vector;

-- -------------------------------------------------------------
-- devices  设备注册表
--   记录每台 ESP32 摄像头的 MAC 地址、设备名、物理位置。
--   推理服务通过 MAC 地址查询此表，将原始硬件标识映射为
--   可读的设备名（desk-cam-01）和位置（study-desk）。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    id            SERIAL PRIMARY KEY,
    mac           VARCHAR(17)  NOT NULL UNIQUE,  -- MAC 格式：E8:F6:0A:8C:F4:44
    name          VARCHAR(64)  NOT NULL,          -- 设备名，如 desk-cam-01
    location      VARCHAR(128),                   -- 物理位置，如 study-desk
    stream_url    VARCHAR(256),                   -- MJPEG 流地址，如 http://192.168.50.87:81/
    registered_at TIMESTAMP    NOT NULL DEFAULT NOW()
);
-- 幂等添加 stream_url 列（已有旧表时）
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stream_url VARCHAR(256);

-- -------------------------------------------------------------
-- vision_log  检测记录表
--   每次调用 /detect 或 /describe 写入一条记录。
--   image_url 存储图片文件路径（非 base64），由 cleanup.py 定时清理。
--   labels 为数组类型，支持 GIN 索引加速标签过滤查询。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vision_log (
    id          SERIAL PRIMARY KEY,
    captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
    camera_ip   VARCHAR(45),           -- 摄像头 IP（ESP32 上报）
    device_mac  VARCHAR(17),           -- 原始 MAC 地址
    device_name VARCHAR(64),           -- 解析后的设备名（来自 devices 表）
    labels      TEXT[],                -- 检测到的标签列表，如 {person, laptop}
    description TEXT,                  -- 文字描述，如 "Detected: 1x person"
    image_url   TEXT,                  -- 图片文件路径
    confidence  JSONB,                 -- 各标签置信度，如 {"person": 0.803}
    raw_result  JSONB                  -- 完整推理输出（detections + custom_matches）
);

-- 按时间倒序查询（历史记录页面常用）
CREATE INDEX IF NOT EXISTS idx_vision_log_captured_at ON vision_log (captured_at DESC);
-- 按设备过滤
CREATE INDEX IF NOT EXISTS idx_vision_log_device_mac  ON vision_log (device_mac);
-- 标签数组全文检索（支持 @> 运算符，如 labels @> ARRAY['person']）
CREATE INDEX IF NOT EXISTS idx_vision_log_labels      ON vision_log USING GIN (labels);

-- -------------------------------------------------------------
-- custom_items  自定义物品表
--   存储用户注册的自定义物品（钥匙、水杯等非 YOLO 标准类别）。
--   embedding 为 CLIP ViT-B/32 生成的 512 维语义向量，
--   支持 few-shot 追加样本（滚动平均更新），sample_count 记录样本数。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_items (
    id            SERIAL PRIMARY KEY,
    label         VARCHAR(128) NOT NULL UNIQUE,  -- 物品名称，如 "我的钥匙"
    description   TEXT,                           -- 可选描述
    embedding     vector(512),                    -- CLIP 语义向量（512 维）
    sample_count  INTEGER      NOT NULL DEFAULT 0,
    owner         VARCHAR(64),                    -- 注册者标识（预留）
    registered_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ivfflat 近似最近邻索引，余弦距离（<=>）
-- lists=50 适合数百至数千条记录的规模
CREATE INDEX IF NOT EXISTS idx_custom_items_embedding
    ON custom_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- -------------------------------------------------------------
-- faces  人脸注册表
--   存储已注册人员的 InsightFace buffalo_l 512 维 embedding。
--   同一人多次注册时使用滚动平均，始终只有一条记录。
--   自适应学习：低置信度识别时自动更新 embedding，updated_at 触发器记录时间。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faces (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(128) NOT NULL,          -- 人员姓名
    label         VARCHAR(128),                   -- 可选展示标签
    embedding     vector(512)  NOT NULL,          -- InsightFace 人脸向量（512 维）
    image_url     TEXT,                           -- 最近一次注册/学习的图片路径
    det_score     FLOAT,                          -- 人脸检测置信度
    source_device VARCHAR(17),                    -- 注册时使用的设备 MAC
    sample_count  INTEGER      NOT NULL DEFAULT 1, -- 累积样本数
    registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW() -- 由触发器自动维护
);

-- ivfflat 近似最近邻索引，余弦距离（<=>）
CREATE INDEX IF NOT EXISTS idx_faces_embedding
    ON faces USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
-- 按姓名查询（注册/更新时判重）
CREATE INDEX IF NOT EXISTS idx_faces_name ON faces (name);

-- -------------------------------------------------------------
-- update_updated_at  触发器函数
--   在 faces 表任意行更新前自动刷新 updated_at 字段，
--   用于追踪自适应学习的最后更新时间。
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_faces_updated_at ON faces;
CREATE TRIGGER trg_faces_updated_at
    BEFORE UPDATE ON faces
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
