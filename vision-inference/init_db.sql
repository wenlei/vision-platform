-- vision_db init_db.sql
-- ?????????? IF NOT EXISTS???????

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS devices (
    id            SERIAL PRIMARY KEY,
    mac           VARCHAR(17)  NOT NULL UNIQUE,
    name          VARCHAR(64)  NOT NULL,
    location      VARCHAR(128),
    registered_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vision_log (
    id          SERIAL PRIMARY KEY,
    captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
    camera_ip   VARCHAR(45),
    device_mac  VARCHAR(17),
    device_name VARCHAR(64),
    labels      TEXT[],
    description TEXT,
    image_url   TEXT,
    confidence  JSONB,
    raw_result  JSONB
);

CREATE INDEX IF NOT EXISTS idx_vision_log_captured_at ON vision_log (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_vision_log_device_mac  ON vision_log (device_mac);
CREATE INDEX IF NOT EXISTS idx_vision_log_labels      ON vision_log USING GIN (labels);

CREATE TABLE IF NOT EXISTS custom_items (
    id            SERIAL PRIMARY KEY,
    label         VARCHAR(128) NOT NULL UNIQUE,
    description   TEXT,
    embedding     vector(512),
    sample_count  INTEGER      NOT NULL DEFAULT 0,
    owner         VARCHAR(64),
    registered_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_items_embedding
    ON custom_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE TABLE IF NOT EXISTS faces (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(128) NOT NULL,
    label         VARCHAR(128),
    embedding     vector(512)  NOT NULL,
    image_url     TEXT,
    det_score     FLOAT,
    source_device VARCHAR(17),
    registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_faces_embedding
    ON faces USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_faces_name ON faces (name);

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
