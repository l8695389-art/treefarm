-- Bảng lưu trữ tổng quát thay thế 2 KV Namespace cũ (USERS, ADMINS).
-- "ns" phân biệt namespace ("users" hoặc "admins"), "key" là key gốc y hệt
-- key đã dùng trong KV (vd "user:12345", "nhiemvu:482913", "danh_sach_admin").
CREATE TABLE IF NOT EXISTS kv (
  ns    TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (ns, key)
);

-- Tăng tốc list() theo prefix (LIKE 'prefix%') kết hợp sắp xếp theo key —
-- D1/SQLite dùng chung index (ns, key) ở PRIMARY KEY nên không cần thêm
-- index phụ, nhưng khai báo tường minh cho rõ ý định.
CREATE INDEX IF NOT EXISTS idx_kv_ns_key ON kv (ns, key);
