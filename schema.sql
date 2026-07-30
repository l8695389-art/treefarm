-- ==================================================
-- D1 SCHEMA — chuyển từ Workers KV
-- Chạy: npx wrangler d1 execute vuacaytien-db --file=./schema.sql [--remote]
-- Giữ nguyên trong KV (không chuyển): danh_sach_admin, che-do-bao-tri,
-- tai-khoan-nhan:{uid}, cache-bang-xep-hang (chuyển sang binding ADMINS,
-- ghi thưa — 1 lần/15-60 phút qua Cron, không đáng chuyển sang D1).
-- ==================================================

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  ten TEXT,
  username TEXT,
  ngay_tham_gia TEXT,
  coin INTEGER DEFAULT 0,
  tong_da_kiem INTEGER DEFAULT 0,
  coin_tu_ban_be INTEGER DEFAULT 0,
  gioi_thieu_boi TEXT,
  cap_dao INTEGER DEFAULT 1,
  xp_dao INTEGER DEFAULT 0,
  tong_coin_dao_tich_luy INTEGER DEFAULT 0,
  dao_dang_dao INTEGER DEFAULT 0,
  dao_bat_dau_luc INTEGER,
  dao_ket_thuc_luc INTEGER,
  dao_lan_cuoi_cong_luc INTEGER,
  moc_mua_giai_so INTEGER,
  moc_mua_giai_coin_goc INTEGER,
  moc_mua_giai_ban_be_goc INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_gioi_thieu_boi ON users(gioi_thieu_boi);
CREATE INDEX IF NOT EXISTS idx_users_mua_giai ON users(moc_mua_giai_so);

CREATE TABLE IF NOT EXISTS ban_be (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nguoi_moi_uid TEXT NOT NULL,
  ban_uid TEXT,
  ten TEXT,
  tham_gia_luc INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ban_be_nguoi_moi ON ban_be(nguoi_moi_uid, tham_gia_luc DESC);

CREATE TABLE IF NOT EXISTS giao_dich_rut (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  ngan_hang TEXT,
  so_tk TEXT,
  ten_nguoi_nhan TEXT,
  so_coin INTEGER,
  so_tien INTEGER,
  trang_thai TEXT DEFAULT 'cho_duyet',
  tao_luc INTEGER,
  duyet_luc INTEGER,
  duyet_boi TEXT,
  key_ngay TEXT,
  key_tuan TEXT
);
CREATE INDEX IF NOT EXISTS idx_gdr_uid ON giao_dich_rut(uid, tao_luc DESC);
CREATE INDEX IF NOT EXISTS idx_gdr_trang_thai ON giao_dich_rut(trang_thai, tao_luc ASC);

CREATE TABLE IF NOT EXISTS han_muc_rut (
  uid TEXT,
  ky TEXT,
  loai TEXT,
  da_rut INTEGER DEFAULT 0,
  PRIMARY KEY (uid, ky, loai)
);

CREATE TABLE IF NOT EXISTS nhiem_vu (
  ma TEXT PRIMARY KEY,
  uid TEXT,
  link TEXT,
  ngay TEXT,
  da_dung INTEGER DEFAULT 0,
  tao_luc INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nv_uid_dadung ON nhiem_vu(uid, da_dung, tao_luc DESC);

CREATE TABLE IF NOT EXISTS diem_danh (
  uid TEXT PRIMARY KEY,
  chuoi_hien_tai INTEGER DEFAULT 0,
  ngay_cuoi TEXT
);

CREATE TABLE IF NOT EXISTS dem_so_lan_ngay (
  uid TEXT,
  loai TEXT,
  ngay TEXT,
  so_lan INTEGER DEFAULT 0,
  lan_cuoi INTEGER,
  PRIMARY KEY (uid, loai, ngay)
);

CREATE TABLE IF NOT EXISTS mua_giai (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  so INTEGER,
  bat_dau INTEGER,
  ket_thuc INTEGER
);
