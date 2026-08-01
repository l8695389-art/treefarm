import { telegramApi, cho } from "./telegram.js";

// ==================================================
// 🗄️ LỚP TƯƠNG THÍCH D1 — GIẢ LẬP GIAO DIỆN KV TRÊN NỀN D1
// Toàn bộ code phía dưới gọi env.USERS.get/put/delete/list và
// env.ADMINS.get/put y hệt như khi dùng KV Namespace thật — KHÔNG cần sửa
// bất kỳ hàm nghiệp vụ nào (đào coin, hoa hồng, BXH, rút tiền...). Chỉ cần
// đổi lớp lưu trữ bên dưới bằng bảng D1 "kv" (ns, key) → value.
//
// Bảng D1 cần tạo trước (xem schema.sql đi kèm):
//   CREATE TABLE kv (
//     ns    TEXT NOT NULL,
//     key   TEXT NOT NULL,
//     value TEXT,
//     PRIMARY KEY (ns, key)
//   );
//
// wrangler.toml cần khai báo binding D1 tên "DB":
//   [[d1_databases]]
//   binding = "DB"
//   database_name = "vua-cay-tien"
//   database_id = "<id>"
// ==================================================

// Escape ký tự đặc biệt của LIKE (%, _, \) để prefix match chính xác.
function thoatKyTuLike(chuoi) {
  return chuoi.replace(/[\\%_]/g, (m) => "\\" + m);
}

async function d1Get(db, ns, key) {
  const hang = await db.prepare("SELECT value FROM kv WHERE ns = ?1 AND key = ?2").bind(ns, key).first();
  return hang ? hang.value : null;
}

async function d1Put(db, ns, key, value) {
  await db
    .prepare(
      "INSERT INTO kv (ns, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value"
    )
    .bind(ns, key, String(value))
    .run();
}

async function d1Delete(db, ns, key) {
  await db.prepare("DELETE FROM kv WHERE ns = ?1 AND key = ?2").bind(ns, key).run();
}

// Giả lập KV.list({ prefix, cursor, limit }) — phân trang theo key (ORDER BY
// key ASC), cursor là key cuối cùng của trang trước. Trả về đúng hình dạng
// { keys: [{name}], list_complete, cursor } như KV thật để duyetTatCaNguoiDung
// và các chỗ gọi list() khác không cần sửa.
async function d1List(db, ns, { prefix = "", cursor = null, limit = 1000 } = {}) {
  const gioiHan = limit || 1000;
  const thamSo = [ns, thoatKyTuLike(prefix) + "%"];
  let cauLenh = "SELECT key FROM kv WHERE ns = ?1 AND key LIKE ?2 ESCAPE '\\'";
  if (cursor) {
    cauLenh += " AND key > ?3";
    thamSo.push(cursor);
  }
  cauLenh += ` ORDER BY key ASC LIMIT ${cursor ? "?4" : "?3"}`;
  thamSo.push(gioiHan + 1); // lấy dư 1 dòng để biết còn trang sau hay không

  const { results } = await db.prepare(cauLenh).bind(...thamSo).all();
  const conTrang = results.length > gioiHan;
  const keys = results.slice(0, gioiHan).map((r) => ({ name: r.key }));

  return {
    keys,
    list_complete: !conTrang,
    cursor: conTrang ? keys[keys.length - 1].name : undefined,
  };
}

// Tạo object có giao diện y hệt KV Namespace (get/put/delete/list) nhưng
// chạy trên D1, phân theo "ns" (namespace) để dữ liệu USERS và ADMINS
// không lẫn nhau dù cùng chung 1 bảng "kv".
function taoD1TheoKV(db, ns) {
  return {
    get: (key) => d1Get(db, ns, key),
    put: (key, value) => d1Put(db, ns, key, value),
    delete: (key) => d1Delete(db, ns, key),
    list: (tuyChon) => d1List(db, ns, tuyChon || {}),
  };
}

// Bọc env gốc: thay USERS/ADMINS (trước đây là KV Namespace binding) bằng
// adapter D1 ở trên. Không mutate env gốc — trả về 1 object mới để tránh
// side-effect ngoài ý muốn giữa các request chạy song song trên cùng Worker.
function boQuaD1(env) {
  return {
    ...env,
    USERS: taoD1TheoKV(env.DB, "users"),
    ADMINS: taoD1TheoKV(env.DB, "admins"),
  };
}

const KEY_DANH_SACH_ADMIN = "danh_sach_admin";
const KEY_BAO_TRI = "che-do-bao-tri"; // giá trị "1" = đang bảo trì (chặn toàn bộ miniapp + API), khác "1" = hoạt động bình thường
const TIEN_TO_USER = "user:";
const TIEN_TO_QC_SO_LAN_NGAY = "qc-so-lan-ngay:";
const QC_GIOI_HAN_NGAY = 20;
const TIEN_TO_QC_LAN_CUOI = "qc-lan-cuoi:"; // mốc thời gian lần xem quảng cáo gần nhất — chặn spam
const QC_CHO_TOI_THIEU_MS = 5 * 60 * 1000; // phải chờ tối thiểu 5 phút giữa 2 lần xem quảng cáo
const TIEN_TO_ADSGRAM_SO_LAN_NGAY = "adsgram-so-lan-ngay:"; // số lần được cộng thưởng Adsgram hôm nay
const ADSGRAM_GIOI_HAN_NGAY = 20;
const TIEN_TO_ADSGRAM_LAN_CUOI = "adsgram-lan-cuoi:"; // mốc thời gian lần cộng thưởng Adsgram gần nhất — chặn callback dồn dập
const ADSGRAM_CHO_TOI_THIEU_MS = 5 * 60 * 1000; // phải chờ tối thiểu 5 phút giữa 2 lần được cộng thưởng Adsgram
const TIEN_TO_TAI_KHOAN_NHAN = "tai-khoan-nhan:";
const TIEN_TO_BAN_BE = "ban-be:"; // ban-be:{uid_nguoi_moi} — JSON array các bạn đã mời qua link ref_
const SO_NGAY_DOI_TAI_KHOAN = 20; // chỉ cho đổi tài khoản nhận tiền 20 ngày / 1 lần
const TIEN_TO_GIAO_DICH_RUT = "giao-dich-rut:"; // giao-dich-rut:{uid}:{id} — lịch sử + trạng thái duyệt
const TIEN_TO_CHO_DUYET_RUT = "cho-duyet-rut:"; // cho-duyet-rut:{uid}:{id} — index riêng các giao dịch CHƯA xử lý, để web admin quét nhanh không phải duyệt toàn bộ lịch sử
const TIEN_TO_RUT_NGAY = "rut-gem-ngay:"; // giữ tiền tố cũ để không lẫn dữ liệu hạn mức trước khi gộp gem vào coin
const TIEN_TO_RUT_TUAN = "rut-gem-tuan:"; // tương tự — tiền tố nội bộ, không hiển thị ra ngoài
const TIEN_TO_SO_LAN_RUT_NGAY = "so-lan-rut-ngay:"; // đếm SỐ LƯỢT gửi yêu cầu rút trong ngày — tách riêng khỏi hạn mức coin/ngày
const SO_LAN_RUT_TOI_DA_NGAY = 1; // mỗi ngày chỉ được gửi 1 yêu cầu rút tiền, bất kể số coin
const COIN_QUY_DOI_DONG_MAU_SO = 100; // 100 coin = 1đ khi rút — coin giờ là đơn vị duy nhất, rút thẳng không cần đổi qua gem nữa
const PHI_RUT_TIEN_PHAN_TRAM = 0.10; // phí dịch vụ 10% mỗi lần rút — trừ trực tiếp vào số tiền quy đổi, KHÔNG đổi số coin bị trừ khỏi ví
const RUT_TOI_THIEU = 200000; // coin (~2.000đ)
const RUT_TOI_DA_NGAY = 1800000; // coin / ngày (~18.000đ)
const RUT_TOI_DA_TUAN = 5000000; // coin / tuần (~50.000đ)
const TIEN_TO_LINK4M_SO_LAN_NGAY = "link4m-so-lan-ngay:"; // số lần hoàn thành nhiệm vụ link4m hôm nay
const LINK4M_GIOI_HAN_NGAY = 3; // tăng từ 2 lên 3 lần/ngày
const TIEN_TO_LINK4M_LAN_CUOI = "link4m-lan-cuoi:"; // mốc thời gian hoàn thành nhiệm vụ link4m gần nhất — chặn vượt liên tục
const LINK4M_CHO_TOI_THIEU_MS = 5 * 60 * 1000; // phải chờ tối thiểu 5 phút giữa 2 lần vượt link
const KEY_CACHE_BANG_XEP_HANG = "cache-bang-xep-hang"; // JSON { kiem_xu, cap_nhat_luc } — làm mới mỗi 15 phút qua Cron Trigger
const KEY_MUA_GIAI = "mua-giai-bxh-hien-tai"; // JSON { bat_dau, ket_thuc } — mùa giải BXH hiện tại, tự mở mùa mới khi hết hạn
const MUA_GIAI_SO_NGAY = 7; // độ dài 1 mùa giải BXH (ngày)
const TOP_NHAN_THUONG = 10; // chỉ Top 10 mỗi bảng xếp hạng mới nhận thưởng khi kết thúc mùa giải (admin trao thủ công, giống quy trình duyệt rút tiền)
const PHAN_THUONG_KIEM_XU = [50000, 10000, 5000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]; // coin thưởng hạng 1→10, BXH "Đua Top Xu"
const TIEN_TO_DIEM_DANH = "diem-danh:"; // diem-danh:{uid} — JSON { chuoi_hien_tai, ngay_cuoi }
const THUONG_DIEM_DANH = [200, 400, 600, 900, 1300, 1600, 2000]; // coin thưởng theo ngày 1→7 trong chu kỳ điểm danh, lặp lại sau ngày 7 (đã giảm ~15 lần so với bản gốc để kéo dài thời gian tích lũy tới mức rút tối thiểu)
const THUONG_COIN_MOI_MOI = 500; // coin chào mừng cho người dùng mới — chỉ nhận 1 lần duy nhất khi /start lần đầu
const THUONG_MOI_BAN_THANH_CONG = 800; // coin thưởng cho người mời khi mời được 1 bạn mới tham gia thành công
const TY_LE_HOA_HONG_GIOI_THIEU = [0.04, 0.02, 0.01]; // % hoa hồng nhiều tầng: cấp 1 (mời trực tiếp) 4%, cấp 2 2%, cấp 3 1% — trên số coin người được mời vừa kiếm được từ nhiệm vụ

// ==================================================
// 🎁 GIFT CODE — admin tạo mã qua lệnh Telegram /taogifcode, người chơi
// nhập mã ở tab Nhiệm vụ để nhận coin ngay. Mỗi mã có số lượt sử dụng tối
// đa (dùng chung cho nhiều người), mỗi user chỉ được nhập 1 mã đúng 1 lần.
// ==================================================
const TIEN_TO_GIFCODE = "gifcode:"; // gifcode:{MA} — JSON { code, coinMin, coinMax, soLuongToiDa, soLuongDaDung, taoLuc, taoBoi }
const TIEN_TO_GIFCODE_DA_DUNG = "gifcode-da-dung:"; // gifcode-da-dung:{MA}:{uid} — đánh dấu user đã nhập mã này rồi, chặn nhập lại

// Gift code TỰ ĐỘNG mỗi ngày — Cron Trigger chạy lúc 21:00 giờ Việt Nam
// (14:00 UTC, xem [triggers] trong wrangler.toml) tự sinh 1 mã mới, random
// 300-500 coin/lượt, tối đa 50 lượt nhập, rồi thông báo vào kênh + nhóm
// giống hệt khi admin gõ lệnh /taogifcode thủ công.
const GIFCODE_TU_DONG_COIN_MIN = 300;
const GIFCODE_TU_DONG_COIN_MAX = 500;
const GIFCODE_TU_DONG_SO_LUONG = 50;

// Parse tham số số coin của gift code: chấp nhận 1 số cố định ("5000") hoặc
// 1 khoảng "min-max" ("4000-5000") — mỗi lượt nhập sẽ random đều trong
// khoảng này. Trả về { min, max } (min === max nếu là số cố định) hoặc
// null nếu chuỗi không hợp lệ.
function phanTichKhoangCoin(chuoi) {
  const phan = chuoi.split("-");
  if (phan.length === 1) {
    const so = Number(phan[0]);
    if (!Number.isFinite(so) || !Number.isInteger(so) || so <= 0) return null;
    return { min: so, max: so };
  }
  if (phan.length === 2) {
    const min = Number(phan[0]);
    const max = Number(phan[1]);
    if (!Number.isFinite(min) || !Number.isInteger(min) || min <= 0) return null;
    if (!Number.isFinite(max) || !Number.isInteger(max) || max <= 0) return null;
    if (min > max) return null;
    return { min, max };
  }
  return null;
}

// Random 1 số coin nguyên trong [min, max] (cả 2 đầu đều có thể ra).
function ngauNhienCoinTrongKhoang(min, max) {
  if (min >= max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Dựng nội dung tin nhắn thông báo Gift Code mới — dùng chung cho broadcast
// tự động ngay sau khi admin tạo mã bằng /taogifcode.
function xayDungTinGifcode(giftcode) {
  const dongThuong =
    giftcode.coinMin === giftcode.coinMax
      ? `${giftcode.coinMin.toLocaleString("vi-VN")} coin`
      : `${giftcode.coinMin.toLocaleString("vi-VN")} - ${giftcode.coinMax.toLocaleString("vi-VN")} coin (ngẫu nhiên)`;

  return (
    "🎁 TÍNH NĂNG MỚI: GIFT CODE!\n\n" +
    "Vua Cày Tiền vừa ra mắt tính năng nhập Gift Code — nhận coin miễn phí cực nhanh!\n\n" +
    "✨ Cách nhận:\n" +
    "1️⃣ Mở app → vào tab Nhiệm vụ\n" +
    '2️⃣ Kéo xuống khối "🎁 Nhập Gift Code"\n' +
    "3️⃣ Bấm vào mã bên dưới để copy, rồi dán vào ô nhập mã\n\n" +
    `🎟️ Mã: \`${giftcode.code}\`\n` +
    `🪙 Thưởng: ${dongThuong}\n` +
    `👥 Giới hạn: ${giftcode.soLuongToiDa.toLocaleString("vi-VN")} người nhanh tay nhất\n\n` +
    "⚠️ Mỗi tài khoản chỉ nhập được 1 lần, hết lượt là hết — nhanh tay kẻo lỡ!\n\n" +
    "💸 Cày coin, đổi thưởng ngay hôm nay tại Vua Cày Tiền 💸"
  );
}

// Tự động sinh 1 gift code mới mỗi ngày (gọi từ Cron Trigger lúc 21:00 giờ
// VN). Mã đặt tên theo ngày (NGAYYYYMMDD) nên idempotent — nếu cron lỡ
// chạy 2 lần trong cùng 1 ngày (vd retry) thì lần sau sẽ thấy mã đã tồn
// tại và bỏ qua, không tạo trùng / không thông báo lại lần 2.
async function taoGifcodeTuDong(env) {
  const homNay = ngayVnHomNay(); // "YYYY-MM-DD"
  const ma = "NGAY" + homNay.replace(/-/g, "");

  const daTonTai = await env.USERS.get(TIEN_TO_GIFCODE + ma);
  if (daTonTai) return; // đã tạo cho hôm nay rồi

  const giftcodeMoi = {
    code: ma,
    coinMin: GIFCODE_TU_DONG_COIN_MIN,
    coinMax: GIFCODE_TU_DONG_COIN_MAX,
    soLuongToiDa: GIFCODE_TU_DONG_SO_LUONG,
    soLuongDaDung: 0,
    taoLuc: Date.now(),
    taoBoi: "he-thong-tu-dong",
  };
  await env.USERS.put(TIEN_TO_GIFCODE + ma, JSON.stringify(giftcodeMoi));

  const tinNhan = xayDungTinGifcode(giftcodeMoi);
  const linkBot = env.LINK_BOT || "https://t.me/vuacaytien_bot";

  const diaChiGui = [];
  if (env.KENH_THONG_BAO) diaChiGui.push(env.KENH_THONG_BAO);
  if (env.NHOM_CHAT) diaChiGui.push(env.NHOM_CHAT);

  for (const chatId of diaChiGui) {
    try {
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: tinNhan,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🎁 Nhập ngay", url: linkBot }]] },
      });
    } catch (e) {
      console.error("Lỗi gửi thông báo gifcode tự động:", e);
    }
  }
}

// ==================================================
// ⛏️ ĐÀO COIN — bấm "Đào Coin" ở Trang chủ, chạy liên tục tối đa 4 giờ,
// coin cộng dần vào ví theo thời gian thực (mỗi lần client poll trạng thái
// sẽ được credit phần coin phát sinh kể từ lần poll trước). Tốc độ đào cơ
// bản 500 coin/giờ, tăng 10%/cấp theo hệ thống cấp độ (tối đa cấp 20).
// ==================================================
const COIN_DAO_MOI_GIO = 300; // coin/giờ ở cấp 1 (chưa cộng bonus)
const THOI_GIAN_DAO_MS = 4 * 60 * 60 * 1000; // 1 phiên đào tối đa 4 giờ liên tục
// "Người chơi gánh hộ 1 phần": client tự nội suy hiển thị coin tăng mượt mỗi
// giây (xem index.html — daoUocTinhTimer), nên server KHÔNG cần chốt sổ
// (ghi KV thật + cộng hoa hồng giới thiệu) mỗi lần client poll nữa — chỉ cần
// chốt tối đa 1 lần / KHOANG_CACH_TOI_THIEU_GHI_DAO_MS cho mỗi user, bất kể
// client gọi /trang-thai-dao dồn dập cỡ nào (poll nhanh, mở nhiều tab, bug,
// hay cố ý spam). Nhờ vậy tổng số write KHÔNG tăng tuyến tính theo tần suất
// poll hay theo số user tăng thêm — mỗi user tự nhiên bị chặn ở 1 trần cố
// định, càng nhiều user online cùng lúc thì mỗi user vẫn chỉ tốn đúng từng
// đó write, sever "dễ thở" hơn nhiều so với ghi mỗi poll.
//
// 600s (10 phút) được chọn để CHỊU ĐƯỢC ~20+ USER ĐỒNG THỜI ngay cả trên
// Cloudflare Workers FREE PLAN (ngân sách cứng 1.000 write/ngày — không co
// giãn). Công thức chọn giá trị này: N user × giờ hoạt động TB/ngày × 3600
// / ngân sách write dành cho đào ≈ khoảng cách tối thiểu (giây). Nếu nâng
// lên Workers Paid plan (~33.000 write/ngày), có thể giảm xuống 90-120s để
// số dư hiển thị đồng bộ nhanh hơn mà vẫn thoải mái gánh 100+ user.
const KHOANG_CACH_TOI_THIEU_GHI_DAO_MS = 600 * 1000;
const CAP_DAO_TOI_DA = 20;
const TANG_TOC_DO_MOI_CAP = 0.1; // +10% tốc độ đào cho mỗi cấp trên cấp 1
const XP_DAO_MOI_CAP_KHOI_DIEM = 500; // cấp 1 cần 500 XP, mỗi cấp sau cộng thêm 500 XP
const XP_MOI_100_COIN_DAO = 5; // mỗi 100 coin đào được (đã cộng vào ví) => +5 XP
const XP_MOI_LUOT_QUANG_CAO = 8; // mỗi lượt xem quảng cáo hoàn thành => +8 XP
const XP_MOI_LUOT_VUOT_LINK = 15; // mỗi lượt vượt link hoàn thành => +15 XP

// XP cần để lên tiếp 1 cấp, tính từ cấp hiện tại: cấp 1→2 cần 500, cấp 2→3
// cần 1.000, cấp 3→4 cần 1.500, v.v. (mỗi cấp sau tăng thêm 500 XP).
function xpCanChoCapTiepTheo(capHienTai) {
  return XP_DAO_MOI_CAP_KHOI_DIEM * capHienTai;
}

// Tốc độ đào hiện tại (coin/giờ) theo cấp — cấp 1 = tốc độ gốc, mỗi cấp
// trên cấp 1 cộng thêm 10%.
function tocDoDaoMoiGio(nguoiDung) {
  const cap = nguoiDung.capDao || 1;
  return COIN_DAO_MOI_GIO * (1 + TANG_TOC_DO_MOI_CAP * (cap - 1));
}

// Cộng XP + tự động lên cấp (có thể lên nhiều cấp cùng lúc nếu dư XP).
// Dừng cộng XP khi đã đạt cấp tối đa (CAP_DAO_TOI_DA).
function congXpDaoVaLenCap(nguoiDung, soXpCong) {
  if (!soXpCong || soXpCong <= 0) return;
  if (!nguoiDung.capDao) nguoiDung.capDao = 1;
  if (!nguoiDung.xpDao) nguoiDung.xpDao = 0;
  if (nguoiDung.capDao >= CAP_DAO_TOI_DA) return; // đã max cấp, không cần XP nữa

  nguoiDung.xpDao += soXpCong;
  while (nguoiDung.capDao < CAP_DAO_TOI_DA) {
    const canDe = xpCanChoCapTiepTheo(nguoiDung.capDao);
    if (nguoiDung.xpDao < canDe) break;
    nguoiDung.xpDao -= canDe;
    nguoiDung.capDao += 1;
  }
  if (nguoiDung.capDao >= CAP_DAO_TOI_DA) nguoiDung.xpDao = 0; // đã max, không tích thêm dư
}

// Cộng coin đào được vào ví + quy đổi XP theo mốc mỗi 100 coin đào cộng
// dồn (dùng tongCoinDaoTichLuy làm bộ đếm riêng, không lẫn với tongDaKiem
// chung — vì tongDaKiem còn tính cả quảng cáo/link4m/điểm danh/hoa hồng).
function congCoinDaoVaTinhXp(nguoiDung, soCoinMoi) {
  if (!soCoinMoi || soCoinMoi <= 0) return;
  const truoc = nguoiDung.tongCoinDaoTichLuy || 0;
  const sau = truoc + soCoinMoi;
  nguoiDung.tongCoinDaoTichLuy = sau;

  const mocXpTruoc = Math.floor(truoc / 100);
  const mocXpSau = Math.floor(sau / 100);
  const soMocMoi = mocXpSau - mocXpTruoc;
  if (soMocMoi > 0) congXpDaoVaLenCap(nguoiDung, soMocMoi * XP_MOI_100_COIN_DAO);

  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinMoi;
  congCoin(nguoiDung, soCoinMoi);
}

// Tính phần coin phát sinh từ lần credit gần nhất tới hiện tại (bị chặn ở
// mốc kết thúc phiên 4 giờ), credit vào ví + XP + hoa hồng giới thiệu, rồi
// cập nhật lại mốc lanCuoiCongLuc. Trả về true nếu phiên đã kết thúc.
// batBuoc=true dùng khi BẮT BUỘC phải chốt sổ ngay (vd sắp ghi đè phiên đào
// bằng phiên mới ở xuLyBatDauDao) — nếu không chốt ngay, phần coin phát sinh
// từ lần chốt gần nhất tới giờ sẽ bị MẤT vĩnh viễn khi object dao cũ bị thay.
// Khi gọi thường xuyên qua poll (batBuoc=false, mặc định), hàm chỉ thực sự
// ghi KV khi đã đủ KHOANG_CACH_TOI_THIEU_GHI_DAO_MS kể từ lần chốt trước,
// hoặc phiên đã kết thúc (buộc phải chốt để dừng đúng lúc). Trả về
// { daKetThuc, daGhi } để caller biết có cần luuNguoiDung() hay không —
// đa số lần poll sẽ trả daGhi=false, tức KHÔNG tốn write KV nào cả.
async function xuLyCreditDaoNeuCo(env, uid, nguoiDung, batBuoc = false) {
  const dao = nguoiDung.dao;
  if (!dao || !dao.dangDao) return { daKetThuc: false, daGhi: false };

  const bayGio = Date.now();
  const moc = Math.min(bayGio, dao.ketThucLuc);
  const daKetThuc = bayGio >= dao.ketThucLuc;
  const msTroi = Math.max(0, moc - (dao.lanCuoiCongLuc || dao.batDauLuc));

  const duDieuKienChotSo = batBuoc || daKetThuc || msTroi >= KHOANG_CACH_TOI_THIEU_GHI_DAO_MS;
  if (!duDieuKienChotSo) return { daKetThuc: false, daGhi: false };

  if (msTroi > 0) {
    const coinMoi = Math.floor((msTroi / (60 * 60 * 1000)) * tocDoDaoMoiGio(nguoiDung));
    if (coinMoi > 0) {
      congCoinDaoVaTinhXp(nguoiDung, coinMoi);
      await congHoaHongGioiThieu(env, uid, coinMoi);
    }
    dao.lanCuoiCongLuc = moc;
  }

  if (daKetThuc) dao.dangDao = false;
  return { daKetThuc, daGhi: true };
}

function thongTinDaoDeTra(nguoiDung) {
  const cap = nguoiDung.capDao || 1;
  const xp = nguoiDung.xpDao || 0;
  const daMax = cap >= CAP_DAO_TOI_DA;
  const dao = nguoiDung.dao || null;
  const dangDao = !!(dao && dao.dangDao);

  return {
    coin: nguoiDung.coin || 0,
    cap_dao: cap,
    xp_dao: xp,
    xp_can_cap_tiep: daMax ? 0 : xpCanChoCapTiepTheo(cap),
    da_max_cap: daMax,
    toc_do_dao_moi_gio: tocDoDaoMoiGio(nguoiDung),
    dang_dao: dangDao,
    bat_dau_luc: dangDao ? dao.batDauLuc : null,
    ket_thuc_luc: dangDao ? dao.ketThucLuc : null,
  };
}

// ==================================================
// 📋 QUẢN LÝ ADMIN — KV thay cho FILE_ADMIN (json)
// ==================================================
async function layDanhSachAdmin(env) {
  const raw = await env.ADMINS.get(KEY_DANH_SACH_ADMIN);
  if (raw) return JSON.parse(raw);
  const macDinh = [env.CHU_SO_HUU];
  // Không để việc ghi KV thất bại (vd hết quota put()/ngày) làm crash toàn
  // bộ xử lý tin nhắn — nếu ghi lỗi, vẫn trả về danh sách mặc định để bot
  // tiếp tục hoạt động, chỉ là lần sau sẽ thử ghi lại.
  try {
    await env.ADMINS.put(KEY_DANH_SACH_ADMIN, JSON.stringify(macDinh));
  } catch (e) {
    console.error("Không ghi được danh_sach_admin vào KV:", e);
  }
  return macDinh;
}

async function luuDanhSachAdmin(env, danhSach) {
  await env.ADMINS.put(KEY_DANH_SACH_ADMIN, JSON.stringify(danhSach));
}

async function laAdmin(env, uid) {
  const danhSach = await layDanhSachAdmin(env);
  return danhSach.includes(String(uid));
}

// ==================================================
// 🛠️ CHẾ ĐỘ BẢO TRÌ — admin bật/tắt qua lệnh Telegram /baotri, không cần
// deploy lại. Khi bật, toàn bộ miniapp + API (trừ webhook Telegram và
// trang quản lý rút tiền) sẽ trả về màn hình "Đang bảo trì" thay vì hoạt
// động bình thường — hữu ích khi cần tạm dừng app (vd hết quota KV, đang
// vá lỗi gấp) mà không muốn user thấy lỗi tràn lan.
// ==================================================
async function dangBaoTri(env) {
  const gt = await env.ADMINS.get(KEY_BAO_TRI);
  return gt === "1";
}

async function datCheDoBaoTri(env, bat) {
  await env.ADMINS.put(KEY_BAO_TRI, bat ? "1" : "0");
}

// ==================================================
// 👤 DỮ LIỆU NGƯỜI DÙNG — KV thay cho FILE_NGUOI_DUNG (json)
// ==================================================
async function layNguoiDung(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_USER + uid);
  return raw ? JSON.parse(raw) : null;
}

async function luuNguoiDung(env, uid, duLieu) {
  await env.USERS.put(TIEN_TO_USER + uid, JSON.stringify(duLieu));
}

// Cộng coin cho user (mutate tại chỗ) — không lưu KV ở đây, gọi luuNguoiDung()
// sau khi xong (để gộp chung 1 lần ghi với các field khác). Coin là đơn vị
// duy nhất — rút thẳng, không còn quy đổi qua gem.
function congCoin(nguoiDung, soCoinCong) {
  nguoiDung.coin = (nguoiDung.coin || 0) + soCoinCong;
  return nguoiDung;
}

// ==================================================
// 👥 HOA HỒNG MỜI BẠN NHIỀU TẦNG (3 cấp)
// Mỗi khi 1 người kiếm được coin từ nhiệm vụ (quảng cáo / vượt link /
// điểm danh), người mời trực tiếp và người mời của người mời cũng được
// trích % thưởng — KHÔNG cộng dồn qua từng tầng, mỗi cấp hưởng đúng %
// cố định của mình trên số coin gốc:
//   Cấp 1 (người mời trực tiếp)        4%
//   Cấp 2 (người mời của người mời)    2%
//   Cấp 3 (mời của mời của người mời)  1%
// Ví dụ: A mời B, B mời C, C mời D. Khi D kiếm được coin:
// C được 4% (cấp 1 của D), B được 2% (cấp 2 của D), A được 1% (cấp 3 của D).
// ==================================================
async function congHoaHongGioiThieu(env, uid, soCoinGoc) {
  if (!soCoinGoc || soCoinGoc <= 0) return;

  let uidHienTai = uid;
  for (let cap = 0; cap < TY_LE_HOA_HONG_GIOI_THIEU.length; cap++) {
    const nguoiHienTai = await layNguoiDung(env, uidHienTai);
    const uidCapTren = nguoiHienTai && nguoiHienTai.gioiThieuBoi;
    if (!uidCapTren) break;

    const nguoiCapTren = await layNguoiDung(env, uidCapTren);
    if (!nguoiCapTren) break; // đứt chuỗi (tài khoản người giới thiệu không còn tồn tại)

    const hoaHong = Math.floor(soCoinGoc * TY_LE_HOA_HONG_GIOI_THIEU[cap]);
    if (hoaHong > 0) {
      nguoiCapTren.coin = (nguoiCapTren.coin || 0) + hoaHong;
      nguoiCapTren.tongDaKiem = (nguoiCapTren.tongDaKiem || 0) + hoaHong;
      nguoiCapTren.coinTuBanBe = (nguoiCapTren.coinTuBanBe || 0) + hoaHong; // cộng dồn riêng "coin kiếm được từ bạn bè", hiển thị ở tab Bạn bè
      await luuNguoiDung(env, uidCapTren, nguoiCapTren);
    }
    uidHienTai = uidCapTren;
  }
}

async function* duyetTatCaNguoiDung(env) {
  let cursor;
  for (;;) {
    const trang = await env.USERS.list({ prefix: TIEN_TO_USER, cursor });
    for (const key of trang.keys) {
      yield key.name.slice(TIEN_TO_USER.length);
    }
    if (trang.list_complete) break;
    cursor = trang.cursor;
  }
}

// ==================================================
// 📝 GHI LOG & THÔNG BÁO — FORWARD VÀO NHÓM
// (bỏ FILE_LOG cục bộ — Workers không có filesystem ghi được;
// nhóm log giữ vai trò log tập trung thay thế)
// ==================================================
function loaiChat(message) {
  return ["group", "supergroup"].includes(message.chat.type) ? "👥 NHÓM" : "👤 RIÊNG";
}

function noiDungTinNhan(message) {
  if (message.text) return `📝 Nội dung: ${message.text}`;
  if (message.photo) return "🖼️ ẢNH";
  if (message.sticker) return `🎯 STICKER | Emoji: ${message.sticker.emoji || ""}`;
  if (message.animation) return "🎬 GIF";
  if (message.video) return "📹 VIDEO";
  if (message.document) return `📄 TẬP TIN | Tên: ${message.document.file_name}`;
  if (message.audio) return "🎵 AUDIO";
  if (message.voice) return "🎙️ VOICE";
  return "🔹 Loại: KHÁC";
}

async function ghiLogVaThongBao(env, message, noiDungThem = "") {
  const uid = message.from.id;
  const ten = `${message.from.first_name} ${message.from.last_name || ""}`.trim();
  const uname = `@${message.from.username || "khong_co"}`;
  const thoiGian = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const tenNhom = loaiChat(message) === "👥 NHÓM" ? ` | Nhóm: ${message.chat.title}` : "";

  const logText =
    `[${thoiGian}] ${loaiChat(message)}${tenNhom}\n` +
    `👤 ID: ${uid} | Tên: ${ten} | ${uname}\n` +
    `${noiDungTinNhan(message)} ${noiDungThem}`;

  // Không còn gửi riêng (DM) cho từng admin nữa — log chỉ tập trung vào
  // NHOM_LOG để tránh spam tin nhắn riêng cho admin.
  try {
    await telegramApi(env, "sendMessage", { chat_id: env.NHOM_LOG, text: logText });
    if (!message.text) {
      await telegramApi(env, "forwardMessage", { chat_id: env.NHOM_LOG, from_chat_id: message.chat.id, message_id: message.message_id });
    }
  } catch (e) {
    console.error("Lỗi gửi log vào NHOM_LOG:", e);
  }
}

// ==================================================
// 📋 LỆNH ADMIN
// ==================================================
async function xuLyThemAdmin(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }
  const phan = message.text.trim().split(/\s+/);
  if (phan.length < 2) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /themadmin [ID_nguoi_dung]" });
  }
  const idThem = phan[1];
  const danhSach = await layDanhSachAdmin(env);
  if (danhSach.includes(idThem)) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Người này đã là admin!" });
  }
  danhSach.push(idThem);
  await luuDanhSachAdmin(env, danhSach);
  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `✅ Đã thêm admin ID: ${idThem}` });
}

async function xuLyXoaAdmin(env, message) {
  if (String(message.from.id) !== env.CHU_SO_HUU) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Chỉ chủ sở hữu mới xóa được admin!" });
  }
  const phan = message.text.trim().split(/\s+/);
  if (phan.length < 2) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /xoaadmin [ID_nguoi_dung]" });
  }
  const idXoa = phan[1];
  const danhSach = await layDanhSachAdmin(env);
  if (!danhSach.includes(idXoa) || idXoa === env.CHU_SO_HUU) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Không tồn tại hoặc không thể xóa chủ sở hữu!" });
  }
  await luuDanhSachAdmin(env, danhSach.filter((id) => id !== idXoa));
  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `✅ Đã xóa admin ID: ${idXoa}` });
}

async function xuLyDsAdmin(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Không có quyền!" });
  }
  const danhSach = await layDanhSachAdmin(env);
  const text = "👑 DANH SÁCH ADMIN:\n" + danhSach.map((ad, idx) => `${idx + 1}. ${ad}`).join("\n");
  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text });
}

// /sluser — đếm tổng số user đã từng /start với bot (duyệt qua toàn bộ
// key "user:*" trong D1/KV, giống cách /gui duyệt để broadcast).
async function xuLySoLuongUser(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  let tongSo = 0;
  for await (const _uid of duyetTatCaNguoiDung(env)) {
    tongSo += 1;
  }

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `👥 Tổng số user đã /start với bot: ${tongSo.toLocaleString("vi-VN")}`,
  });
}

// /check [ID] — hiển thị TOÀN BỘ thông tin của 1 người chơi: coin, tổng đã
// kiếm, cấp/XP đào, trạng thái phiên đào hiện tại, chuỗi điểm danh, người
// giới thiệu, số bạn đã mời, tài khoản nhận tiền đã liên kết, hạn mức rút
// đã dùng trong ngày/tuần. Gộp nhiều nguồn dữ liệu (user, điểm danh, tài
// khoản nhận, bạn bè, counter rút tiền) vào 1 tin nhắn duy nhất cho admin
// tra cứu nhanh khi cần hỗ trợ/điều tra 1 tài khoản cụ thể.
async function xuLyCheckUser(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const phan = message.text.trim().split(/\s+/);
  if (phan.length < 2) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /check [ID_nguoi_dung]" });
  }

  const uid = phan[1];
  const nguoiDung = await layNguoiDung(env, uid);
  if (!nguoiDung) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `❌ Không tìm thấy user ID: ${uid}` });
  }

  const dd = await layDiemDanh(env, uid);

  const rawTaiKhoan = await env.USERS.get(TIEN_TO_TAI_KHOAN_NHAN + uid);
  const taiKhoan = rawTaiKhoan ? JSON.parse(rawTaiKhoan) : null;

  const rawBanBe = await env.USERS.get(TIEN_TO_BAN_BE + uid);
  const danhSachBanBe = rawBanBe ? JSON.parse(rawBanBe) : [];

  const homNay = ngayVnHomNay();
  const tuanNay = dauTuanVN();
  const daRutNgay = Number((await env.USERS.get(TIEN_TO_RUT_NGAY + uid + ":" + homNay)) || 0);
  const daRutTuan = Number((await env.USERS.get(TIEN_TO_RUT_TUAN + uid + ":" + tuanNay)) || 0);
  const soLanDaRutHomNay = Number((await env.USERS.get(TIEN_TO_SO_LAN_RUT_NGAY + uid + ":" + homNay)) || 0);

  const dao = nguoiDung.dao;
  let daoText = "Không đang đào";
  if (dao && dao.dangDao) {
    const conLaiMs = Math.max(0, dao.ketThucLuc - Date.now());
    const phut = Math.floor(conLaiMs / 60000);
    daoText = conLaiMs > 0 ? `⛏️ Đang đào — còn ${phut} phút` : "⛏️ Đang đào — sắp hoàn tất";
  }

  const text =
    `👤 THÔNG TIN NGƯỜI CHƠI\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: ${uid}\n` +
    `📛 Tên: ${nguoiDung.ten || "?"}\n` +
    `🔖 Username: ${nguoiDung.username ? "@" + nguoiDung.username : "Không có"}\n` +
    `📅 Tham gia lúc: ${nguoiDung.ngay_tham_gia || "?"}\n\n` +
    `🪙 Coin hiện có: ${(nguoiDung.coin || 0).toLocaleString("vi-VN")}\n` +
    `📊 Tổng đã kiếm (lũy kế): ${(nguoiDung.tongDaKiem || 0).toLocaleString("vi-VN")}\n` +
    `👥 Coin kiếm từ bạn bè: ${(nguoiDung.coinTuBanBe || 0).toLocaleString("vi-VN")}\n\n` +
    `⛏️ Cấp đào: ${nguoiDung.capDao || 1}/${CAP_DAO_TOI_DA}\n` +
    `⚡ XP đào: ${(nguoiDung.xpDao || 0).toLocaleString("vi-VN")}\n` +
    `🔄 Trạng thái: ${daoText}\n\n` +
    `🔥 Chuỗi điểm danh: ${dd.chuoi_hien_tai || 0} ngày (gần nhất: ${dd.ngay_cuoi || "chưa điểm danh"})\n\n` +
    `👤 Được giới thiệu bởi (UID): ${nguoiDung.gioiThieuBoi || "Không có"}\n` +
    `👥 Số bạn đã mời: ${danhSachBanBe.length}\n\n` +
    `💳 Tài khoản nhận tiền: ${
      taiKhoan ? `${taiKhoan.nganHang} - ${taiKhoan.soTk} (${taiKhoan.tenNguoiNhan})` : "Chưa liên kết"
    }\n` +
    `💸 Đã rút hôm nay: ${daRutNgay.toLocaleString("vi-VN")} coin (${soLanDaRutHomNay}/${SO_LAN_RUT_TOI_DA_NGAY} lượt)\n` +
    `💸 Đã rút tuần này: ${daRutTuan.toLocaleString("vi-VN")} coin`;

  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text });
}

// /dslenh — liệt kê toàn bộ lệnh dành cho admin kèm mô tả ngắn + cú pháp.
// Chỉ cần cập nhật DANH_SACH_LENH_ADMIN khi thêm/bớt lệnh admin mới, không
// cần sửa gì khác.
const DANH_SACH_LENH_ADMIN = [
  { lenh: "/themadmin [ID]", moTa: "Thêm 1 admin mới (mọi admin đều dùng được)" },
  { lenh: "/xoaadmin [ID]", moTa: "Xóa 1 admin (chỉ chủ sở hữu)" },
  { lenh: "/dsadmin", moTa: "Xem danh sách admin hiện tại" },
  { lenh: "/baotri [bat|tat]", moTa: "Bật/tắt chế độ bảo trì, hoặc xem trạng thái nếu không nhập tham số" },
  { lenh: "/taogifcode [coin hoặc min-max] [code] [so_luot]", moTa: "Tạo gift code mới, tự thông báo vào kênh + nhóm" },
  { lenh: "/checkcode", moTa: "Xem danh sách các gift code đã tạo" },
  { lenh: "/checkcodesl [code]", moTa: "Xem chi tiết + số người đã nhập 1 gift code" },
  { lenh: "/gui", moTa: "Trả lời 1 tin nhắn kèm lệnh này để broadcast tới toàn bộ user" },
  { lenh: "/sluser", moTa: "Xem tổng số user đã /start với bot" },
  { lenh: "/check [ID]", moTa: "Xem toàn bộ thông tin 1 người chơi (coin, cấp đào, điểm danh, ví, bạn bè...)" },
  { lenh: "/dslenh", moTa: "Xem danh sách lệnh admin này" },
];

async function xuLyDsLenh(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const text =
    "🛠️ DANH SÁCH LỆNH ADMIN:\n\n" +
    DANH_SACH_LENH_ADMIN.map((l, idx) => `${idx + 1}. \`${l.lenh}\`\n   ${l.moTa}`).join("\n\n");

  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text, parse_mode: "Markdown" });
}

// /baotri bat | /baotri tat | /baotri (xem trạng thái hiện tại)
async function xuLyBaoTri(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const hanhDong = (message.text.trim().split(/\s+/)[1] || "").toLowerCase();

  if (hanhDong === "bat" || hanhDong === "on") {
    await datCheDoBaoTri(env, true);
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "🛠️ Đã BẬT chế độ bảo trì.\nToàn bộ user sẽ thấy màn hình \"Đang bảo trì\" khi mở app.\nDùng /baotri tat để tắt khi xong.",
    });
  }
  if (hanhDong === "tat" || hanhDong === "off") {
    await datCheDoBaoTri(env, false);
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "✅ Đã TẮT chế độ bảo trì. App hoạt động bình thường trở lại." });
  }

  const dangBat = await dangBaoTri(env);
  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `ℹ️ Chế độ bảo trì hiện đang: ${dangBat ? "🛠️ BẬT" : "✅ TẮT"}\n\nDùng: /baotri bat  hoặc  /baotri tat`,
  });
}

// /taogifcode [so_coin hoặc min-max] [code] [so_luong_duoc_nhap] — tạo gift
// code mới, dùng chung 1 mã cho nhiều người, mỗi người chỉ nhập được 1 lần.
// so_coin có thể là số cố định ("5000") hoặc 1 khoảng ("4000-5000") — nếu
// là khoảng, mỗi lượt nhập sẽ được random 1 số coin ngẫu nhiên trong đó.
async function xuLyTaoGifcode(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const phan = message.text.trim().split(/\s+/);
  if (phan.length < 4) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        "⚠️ Dùng: /taogifcode [so_coin hoặc min-max] [code] [so_luong_duoc_nhap]\n" +
        "VD số cố định: /taogifcode 5000 TET2026 100\n" +
        "VD khoảng random: /taogifcode 4000-5000 TET2026 100",
    });
  }

  const khoangCoin = phanTichKhoangCoin(phan[1]);
  const maGoc = phan[2];
  const soLuong = Number(phan[3]);

  if (!khoangCoin) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "⚠️ Số coin không hợp lệ. Dùng 1 số dương (VD: 5000) hoặc 1 khoảng min-max (VD: 4000-5000).",
    });
  }
  if (!Number.isFinite(soLuong) || !Number.isInteger(soLuong) || soLuong <= 0) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Số lượt nhập phải là số nguyên dương." });
  }

  const ma = maGoc.toUpperCase();
  if (!/^[A-Z0-9_]{3,30}$/.test(ma)) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "⚠️ Mã code chỉ gồm chữ, số, gạch dưới, dài 3-30 ký tự (không dùng dấu \"-\" để tránh lẫn với khoảng coin).",
    });
  }

  const daTonTai = await env.USERS.get(TIEN_TO_GIFCODE + ma);
  if (daTonTai) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `❌ Mã "${ma}" đã tồn tại rồi, chọn mã khác.` });
  }

  const giftcodeMoi = {
    code: ma,
    coinMin: khoangCoin.min,
    coinMax: khoangCoin.max,
    soLuongToiDa: soLuong,
    soLuongDaDung: 0,
    taoLuc: Date.now(),
    taoBoi: String(message.from.id),
  };
  await env.USERS.put(TIEN_TO_GIFCODE + ma, JSON.stringify(giftcodeMoi));

  const dongThuong =
    khoangCoin.min === khoangCoin.max
      ? `${khoangCoin.min.toLocaleString("vi-VN")} coin/lượt`
      : `${khoangCoin.min.toLocaleString("vi-VN")} - ${khoangCoin.max.toLocaleString("vi-VN")} coin/lượt (ngẫu nhiên)`;

  await telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `✅ Đã tạo gift code!\n\n🎁 Mã: \`${ma}\`\n🪙 Thưởng: ${dongThuong}\n👥 Số lượt tối đa: ${soLuong.toLocaleString("vi-VN")}\n\n📣 Đang gửi thông báo tới kênh & nhóm...`,
    parse_mode: "Markdown",
  });

  // Chỉ gửi thông báo vào KÊNH THÔNG BÁO + NHÓM TRÒ CHUYỆN (cấu hình qua
  // biến môi trường KENH_THONG_BAO / NHOM_CHAT trên Worker) — KHÔNG gửi
  // riêng (DM) cho từng user như trước nữa. Vì đây là nhóm/kênh (không
  // phải chat riêng với bot), nút web_app KHÔNG dùng được ở đây (Telegram
  // chỉ cho phép web_app trong chat riêng 1-1 với bot) nên dùng nút "url"
  // trỏ về chat riêng với bot, từ đó user tự bấm nút mở miniapp ở /start.
  const tinNhan = xayDungTinGifcode(giftcodeMoi);
  const linkBot = env.LINK_BOT || "https://t.me/vuacaytien_bot";

  const diaChiGui = [];
  if (env.KENH_THONG_BAO) diaChiGui.push({ ten: "📢 Kênh thông báo", chatId: env.KENH_THONG_BAO });
  if (env.NHOM_CHAT) diaChiGui.push({ ten: "🌐 Nhóm trò chuyện", chatId: env.NHOM_CHAT });

  if (diaChiGui.length === 0) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        "⚠️ Mã đã tạo thành công nhưng CHƯA gửi được thông báo — chưa cấu hình biến môi trường " +
        "KENH_THONG_BAO / NHOM_CHAT trên Worker (Dashboard > Settings > Variables and secrets). " +
        "Nhớ thêm bot làm admin của kênh/nhóm đó trước khi gửi.",
    });
  }

  const ketQuaGui = [];
  for (const dich of diaChiGui) {
    const kq = await telegramApi(env, "sendMessage", {
      chat_id: dich.chatId,
      text: tinNhan,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🎁 Nhập ngay", url: linkBot }]] },
    });
    ketQuaGui.push(`${kq.ok ? "✅" : "❌"} ${dich.ten}`);
  }

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `📣 Kết quả gửi thông báo Gift Code \`${ma}\`:\n${ketQuaGui.join("\n")}`,
    parse_mode: "Markdown",
  });
}

// /checkcode — liệt kê toàn bộ gift code đã tạo (mới nhất trước)
async function xuLyCheckCode(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const danhSachMa = [];
  let cursor;
  for (;;) {
    const trang = await env.USERS.list({ prefix: TIEN_TO_GIFCODE, cursor });
    for (const key of trang.keys) danhSachMa.push(key.name.slice(TIEN_TO_GIFCODE.length));
    if (trang.list_complete) break;
    cursor = trang.cursor;
  }

  if (danhSachMa.length === 0) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "📭 Chưa có gift code nào được tạo." });
  }

  const chiTiet = [];
  for (const ma of danhSachMa) {
    const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
    if (raw) chiTiet.push(JSON.parse(raw));
  }
  chiTiet.sort((a, b) => b.taoLuc - a.taoLuc);

  // Telegram giới hạn 4096 ký tự/tin nhắn — chỉ hiện 50 mã gần nhất, kèm ghi chú nếu còn dư
  const HIEN_TOI_DA = 50;
  const dong = chiTiet.slice(0, HIEN_TOI_DA).map((gc, idx) => {
    const thuong =
      gc.coinMin === gc.coinMax
        ? `${gc.coinMin.toLocaleString("vi-VN")} coin`
        : `${gc.coinMin.toLocaleString("vi-VN")}-${gc.coinMax.toLocaleString("vi-VN")} coin`;
    return `${idx + 1}. \`${gc.code}\` | ${thuong} | ${gc.soLuongDaDung}/${gc.soLuongToiDa} lượt`;
  });

  let text = `🎁 DANH SÁCH GIFT CODE (${chiTiet.length}):\n\n` + dong.join("\n");
  if (chiTiet.length > HIEN_TOI_DA) {
    text += `\n\n… và ${chiTiet.length - HIEN_TOI_DA} mã khác. Dùng /checkcodesl [code] để xem chi tiết 1 mã.`;
  }

  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text, parse_mode: "Markdown" });
}

// /checkcodesl [code] — xem chi tiết + số lượt đã nhập của 1 gift code cụ thể
async function xuLyCheckCodeSoLuong(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const phan = message.text.trim().split(/\s+/);
  if (phan.length < 2) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /checkcodesl [code]" });
  }

  const ma = phan[1].toUpperCase();
  const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
  if (!raw) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `❌ Mã "${ma}" không tồn tại.` });
  }

  const gc = JSON.parse(raw);
  const thuong =
    gc.coinMin === gc.coinMax
      ? `${gc.coinMin.toLocaleString("vi-VN")} coin/lượt`
      : `${gc.coinMin.toLocaleString("vi-VN")} - ${gc.coinMax.toLocaleString("vi-VN")} coin/lượt`;
  const conLai = Math.max(0, gc.soLuongToiDa - gc.soLuongDaDung);
  const ngayTao = new Date(gc.taoLuc).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

  const text =
    `🎁 Mã: \`${gc.code}\`\n` +
    `🪙 Thưởng: ${thuong}\n` +
    `👥 Đã dùng: ${gc.soLuongDaDung.toLocaleString("vi-VN")}/${gc.soLuongToiDa.toLocaleString("vi-VN")}\n` +
    `📊 Còn lại: ${conLai.toLocaleString("vi-VN")} lượt\n` +
    `🕒 Tạo lúc: ${ngayTao}\n` +
    `👤 Tạo bởi: ${gc.taoBoi}`;

  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text, parse_mode: "Markdown" });
}

// ==================================================
// 🚪 /start
// ==================================================
async function xuLyStart(env, message) {
  const uid = String(message.from.id);
  const nguoiDungCu = await layNguoiDung(env, uid);

  // Link mời bạn bè: /start ref_<uid_nguoi_moi> — chỉ tính khi user CHƯA từng
  // tồn tại (né gian lận tự start lại nhiều lần), không tự mời chính mình,
  // và uid trong ref_ phải là 1 tài khoản CÓ THẬT (né giả mạo ref_ tùy ý số).
  const payload = message.text.trim().split(/\s+/)[1] || "";
  const refUidTho = payload.startsWith("ref_") ? payload.slice(4) : null;
  const laNguoiDungMoi = !nguoiDungCu;

  let refUid = null;
  if (laNguoiDungMoi && refUidTho && refUidTho !== uid) {
    const nguoiGioiThieu = await layNguoiDung(env, refUidTho);
    if (nguoiGioiThieu) refUid = refUidTho;
  }

  if (!nguoiDungCu) {
    await luuNguoiDung(env, uid, {
      ten: `${message.from.first_name} ${message.from.last_name || ""}`.trim(),
      username: message.from.username || null,
      ngay_tham_gia: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      coin: THUONG_COIN_MOI_MOI, // 500 coin chào mừng — chỉ nhận 1 lần duy nhất
      tongDaKiem: THUONG_COIN_MOI_MOI, // thưởng chào mừng cũng tính vào bảng xếp hạng
      gioiThieuBoi: refUid,
    });
    await ghiLogVaThongBao(env, message, "| ✅ NGƯỜI DÙNG MỚI");
  } else {
    await ghiLogVaThongBao(env, message, "| Gọi lệnh /start");
  }

  if (laNguoiDungMoi && refUid) {
    await ghiNhanBanBeMoi(env, refUid, {
      uid,
      ten: `${message.from.first_name} ${message.from.last_name || ""}`.trim() || "Người dùng",
      thamGiaLuc: Date.now(),
    });
    await congThuongMoiBanThanhCong(env, refUid); // +10.000 coin cho người mời
  }

  return telegramApi(env, "sendPhoto", {
    chat_id: message.chat.id,
    photo: env.LINK_ANH,
    caption:
      "👋 Chào bạn! Chào mừng đến với Vua Cày Tiền 💸\n\n" +
      "Chăm chỉ, làm nhiệm vụ mỗi ngày và tích xu đổi thưởng.\n" +
      "Mời bạn bè, leo bảng xếp hạng và rút kim cương khi đủ điều kiện.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💸 BẮT ĐẦU CÀY TIỀN NGAY", web_app: { url: env.LINK_MINIAPP } }],
        [{ text: "📢 Kênh thông báo", url: "https://t.me/vuacaytien_news" }],
        [{ text: "🌐 Nhóm trò chuyện", url: "https://t.me/vuacaytien_chat" }],
      ],
    },
  });
}

// ==================================================
// 📢 /gui — broadcast
// ==================================================
async function xuLyGuiThongBao(env, message) {
  if (!(await laAdmin(env, message.from.id))) return;

  const reply = message.reply_to_message;
  if (!reply) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Trả lời tin nhắn cần gửi kèm lệnh /gui" });
  }

  await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⏳ Đang gửi thông báo..." });

  let thanhCong = 0;
  let thatBai = 0;
  for await (const uid of duyetTatCaNguoiDung(env)) {
    const ketQua = await telegramApi(env, "copyMessage", {
      chat_id: Number(uid),
      from_chat_id: message.chat.id,
      message_id: reply.message_id,
    });
    if (ketQua.ok) thanhCong += 1;
    else thatBai += 1;
    await cho(50); // né rate-limit Telegram, giống time.sleep(0.05) bản gốc
  }

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `✅ Hoàn tất!\nThành công: ${thanhCong}\nThất bại: ${thatBai}`,
  });
}

// ==================================================
// 🔀 Router lệnh + bắt tất cả tin nhắn còn lại
// ==================================================
async function xuLyUpdate(env, update) {
  if (update.callback_query) return; // không còn nút duyệt rút tiền qua Telegram — xử lý ở web admin

  const message = update.message;
  if (!message) return;

  if (message.text && message.text.startsWith("/")) {
    const lenh = message.text.trim().split(/\s+/)[0].split("@")[0];
    switch (lenh) {
      case "/start":
        return xuLyStart(env, message);
      case "/themadmin":
        return xuLyThemAdmin(env, message);
      case "/xoaadmin":
        return xuLyXoaAdmin(env, message);
      case "/dsadmin":
        return xuLyDsAdmin(env, message);
      case "/sluser":
        return xuLySoLuongUser(env, message);
      case "/check":
        return xuLyCheckUser(env, message);
      case "/dslenh":
        return xuLyDsLenh(env, message);
      case "/baotri":
        return xuLyBaoTri(env, message);
      case "/taogifcode":
        return xuLyTaoGifcode(env, message);
      case "/checkcode":
        return xuLyCheckCode(env, message);
      case "/checkcodesl":
        return xuLyCheckCodeSoLuong(env, message);
      case "/gui":
        return xuLyGuiThongBao(env, message);
      default:
        return; // lệnh lạ, bỏ qua — giống bản Python
    }
  }

  return ghiLogVaThongBao(env, message);
}

// ==================================================
// 🎯 NHIỆM VỤ VƯỢT LINK — tự host trang xác nhận thay vì tin vào API
// Link4M (Link4M không có API kiểm tra hoàn thành/reward, đã xác minh).
// Mã 6 số chỉ lộ ra ở trang đích SAU khi vượt hết quảng cáo Link4M,
// dùng 1 lần rồi khóa — không phụ thuộc dữ liệu phía Link4M.
// ==================================================
const TIEN_TO_NHIEM_VU = "nhiemvu:";
const TIEN_TO_NHIEM_VU_HIEN_TAI = "nhiemvu-hientai:"; // con trỏ nhiệm vụ đang chờ, để khôi phục khi mở lại app
const TTL_NHIEM_VU_MS = 30 * 60 * 1000; // 30 phút

function ngayVnHomNay() {
  // định dạng YYYY-MM-DD theo giờ Việt Nam, reset đúng 00:00 giờ VN
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

function dauTuanVN() {
  // ngày Thứ Hai của tuần hiện tại, theo giờ VN — dùng làm key gộp giới hạn rút/tuần
  const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const thu = vn.getDay(); // 0 = CN
  const luiVe = thu === 0 ? 6 : thu - 1;
  vn.setDate(vn.getDate() - luiVe);
  const y = vn.getFullYear();
  const m = String(vn.getMonth() + 1).padStart(2, "0");
  const d = String(vn.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ngayTruocVN(ngayStr) {
  // nhận "YYYY-MM-DD", trả về ngày liền trước cùng định dạng — dùng để
  // kiểm tra điểm danh có liên tục (hôm qua) hay bị đứt chuỗi
  const d = new Date(ngayStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function sinhMaNgauNhien() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function layNhiemVuHienTai(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_HIEN_TAI + uid);
  return raw ? JSON.parse(raw) : null;
}

async function luuNhiemVuHienTai(env, uid, duLieu) {
  await env.USERS.put(TIEN_TO_NHIEM_VU_HIEN_TAI + uid, JSON.stringify(duLieu));
}

async function xoaNhiemVuHienTai(env, uid) {
  await env.USERS.delete(TIEN_TO_NHIEM_VU_HIEN_TAI + uid);
}

async function taoNhiemVuMoi(env, uid) {
  for (let lanThu = 0; lanThu < 5; lanThu++) {
    const ma = sinhMaNgauNhien();
    const key = TIEN_TO_NHIEM_VU + ma;
    const daTonTai = await env.USERS.get(key);
    if (daTonTai) continue; // đụng mã hiếm khi xảy ra, thử lại

    await env.USERS.put(key, JSON.stringify({ uid: String(uid), daDung: false, taoLuc: Date.now() }));
    return ma;
  }
  throw new Error("khong_sinh_duoc_ma");
}

async function xuLyTaoNhiemVu(env, url, goc) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chặn sớm nếu hôm nay đã dùng hết lượt rồi (tối đa LINK4M_GIOI_HAN_NGAY
  // lần/ngày) — đỡ tốn 1 lượt gọi Link4M vô ích
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_LINK4M_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= LINK4M_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_hom_nay" });
  }

  // Chặn vượt liên tục — phải cách lần hoàn thành trước tối thiểu
  // LINK4M_CHO_TOI_THIEU_MS (5 phút), tương tự cơ chế chặn spam quảng cáo.
  const lanCuoiXong = Number((await env.USERS.get(TIEN_TO_LINK4M_LAN_CUOI + uid)) || 0);
  const daTroiTuLanCuoi = Date.now() - lanCuoiXong;
  if (lanCuoiXong && daTroiTuLanCuoi < LINK4M_CHO_TOI_THIEU_MS) {
    return Response.json({
      thanh_cong: false,
      loi: "cho_qua_nhanh",
      cho_con_lai_giay: Math.ceil((LINK4M_CHO_TOI_THIEU_MS - daTroiTuLanCuoi) / 1000),
    });
  }

  // Còn nhiệm vụ đang chờ, chưa hoàn thành, chưa hết hạn → trả lại ĐÚNG
  // link cũ, không tạo mới. Đây là cơ chế giữ link khi thoát app rồi mở
  // lại — không cần gọi thêm Link4M, không sinh thêm mã thừa.
  const dangCho = await layNhiemVuHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ thanh_cong: true, link: dangCho.link });
  }

  let ma;
  try {
    ma = await taoNhiemVuMoi(env, uid);
  } catch {
    return Response.json({ thanh_cong: false, loi: "khong_sinh_duoc_ma" }, { status: 500 });
  }

  const trangDich = `${goc}/nv/${ma}`;
  const apiUrl = `https://link4m.co/api-shorten/v2?api=${env.LINK4M_API_TOKEN}&url=${encodeURIComponent(trangDich)}`;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (data.status === "success" && data.shortenedUrl) {
      await luuNhiemVuHienTai(env, uid, { ma, link: data.shortenedUrl, taoLuc: Date.now(), ngay: homNay });
      return Response.json({ thanh_cong: true, link: data.shortenedUrl });
    }
    return Response.json({ thanh_cong: false, loi: data.message || "loi_khong_ro" });
  } catch (e) {
    return Response.json({ thanh_cong: false, loi: String(e) }, { status: 500 });
  }
}

// Trạng thái hiện tại — frontend gọi lúc mở app để khôi phục link cũ,
// biết đã hoàn thành hôm nay chưa (link4m), đã xem bao nhiêu quảng cáo
// hôm nay, và hiện số dư.
async function xuLyNhiemVuHienTai(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const nguoiDung = await layNguoiDung(env, uid);
  const coin = nguoiDung ? nguoiDung.coin || 0 : 0;

  const soLanQcDaXem = Number((await env.USERS.get(TIEN_TO_QC_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const qcLanCuoi = Number((await env.USERS.get(TIEN_TO_QC_LAN_CUOI + uid)) || 0);
  const soLanLink4mDaXong = Number((await env.USERS.get(TIEN_TO_LINK4M_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const link4mLanCuoi = Number((await env.USERS.get(TIEN_TO_LINK4M_LAN_CUOI + uid)) || 0);
  const soLanAdsgramDaXem = Number((await env.USERS.get(TIEN_TO_ADSGRAM_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const adsgramLanCuoi = Number((await env.USERS.get(TIEN_TO_ADSGRAM_LAN_CUOI + uid)) || 0);

  const trangThaiChung = {
    coin,
    so_lan_qc_da_xem: soLanQcDaXem,
    qc_gioi_han_ngay: QC_GIOI_HAN_NGAY,
    qc_lan_cuoi: qcLanCuoi,
    qc_cho_toi_thieu_giay: QC_CHO_TOI_THIEU_MS / 1000,
    so_lan_link4m_da_xong: soLanLink4mDaXong,
    link4m_gioi_han_ngay: LINK4M_GIOI_HAN_NGAY,
    link4m_lan_cuoi: link4mLanCuoi,
    link4m_cho_toi_thieu_giay: LINK4M_CHO_TOI_THIEU_MS / 1000,
    so_lan_adsgram_da_xem: soLanAdsgramDaXem,
    adsgram_gioi_han_ngay: ADSGRAM_GIOI_HAN_NGAY,
    adsgram_lan_cuoi: adsgramLanCuoi,
    adsgram_cho_toi_thieu_giay: ADSGRAM_CHO_TOI_THIEU_MS / 1000,
  };

  if (soLanLink4mDaXong >= LINK4M_GIOI_HAN_NGAY) {
    return Response.json({ trang_thai: "da_hoan_thanh", ...trangThaiChung });
  }

  const dangCho = await layNhiemVuHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ trang_thai: "dang_cho", link: dangCho.link, ...trangThaiChung });
  }

  return Response.json({ trang_thai: "chua_co", ...trangThaiChung });
}

// Xác nhận đã xem quảng cáo Monetag — gọi trong .then() của show_11396646().
// Tối đa QC_GIOI_HAN_NGAY lần/ngày, reset 00:00 giờ VN.
// LƯU Ý BẢO MẬT: đây là callback phía trình duyệt, không có xác thực từ
// phía Monetag server, nên ai rành DevTools cũng có thể tự gọi endpoint
// này. Giới hạn số lần/ngày + số thưởng thấp là lớp phòng vệ duy nhất.
async function xuLyXacNhanQuangCao(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const key = TIEN_TO_QC_SO_LAN_NGAY + uid + ":" + homNay;
  const soLanDaXem = Number((await env.USERS.get(key)) || 0);

  if (soLanDaXem >= QC_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_hom_nay", so_lan_qc_da_xem: soLanDaXem, qc_gioi_han_ngay: QC_GIOI_HAN_NGAY });
  }

  // Chặn xem liên tục — phải cách lần trước tối thiểu 30 giây
  const keyLanCuoi = TIEN_TO_QC_LAN_CUOI + uid;
  const lanCuoi = Number((await env.USERS.get(keyLanCuoi)) || 0);
  const now = Date.now();
  const daTroi = now - lanCuoi;
  if (lanCuoi && daTroi < QC_CHO_TOI_THIEU_MS) {
    return Response.json({
      thanh_cong: false,
      loi: "cho_qua_nhanh",
      cho_con_lai_giay: Math.ceil((QC_CHO_TOI_THIEU_MS - daTroi) / 1000),
      so_lan_qc_da_xem: soLanDaXem,
      qc_gioi_han_ngay: QC_GIOI_HAN_NGAY,
    });
  }

  const soLanMoi = soLanDaXem + 1;
  await env.USERS.put(key, String(soLanMoi));
  await env.USERS.put(keyLanCuoi, String(now));

  const soCoinCong = Number(env.THUONG_COIN_QUANG_CAO || 500); // nếu đã đặt biến môi trường THUONG_COIN_QUANG_CAO trên Worker thì cần cập nhật giá trị đó luôn, vì nó được ưu tiên hơn số mặc định này
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_QUANG_CAO); // +8 XP đào/lượt xem quảng cáo
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_qc_da_xem: soLanMoi,
    qc_gioi_han_ngay: QC_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: QC_CHO_TOI_THIEU_MS / 1000,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
  });
}

// ==================================================
// 🎥 QUẢNG CÁO ADSGRAM — callback SERVER-TO-SERVER, Adsgram tự gọi endpoint
// này sau khi user xem xong quảng cáo (Reward URL cấu hình ở partner.adsgram.ai,
// dạng https://<domain>/adsgram-callback?userid=[userId]). Không có chữ ký
// để verify ở tier này — giới hạn ngày + cooldown là lớp phòng vệ duy nhất,
// y hệt cơ chế của khối quảng cáo Monetag.
// ==================================================
async function xuLyAdsgramCallback(env, url) {
  const uid = url.searchParams.get("userid");
  if (!uid) return new Response("thieu_userid", { status: 400 });

  const homNay = ngayVnHomNay();
  const key = TIEN_TO_ADSGRAM_SO_LAN_NGAY + uid + ":" + homNay;
  const soLanDaXem = Number((await env.USERS.get(key)) || 0);

  if (soLanDaXem >= ADSGRAM_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_hom_nay" });
  }

  const keyLanCuoi = TIEN_TO_ADSGRAM_LAN_CUOI + uid;
  const lanCuoi = Number((await env.USERS.get(keyLanCuoi)) || 0);
  const now = Date.now();
  if (lanCuoi && now - lanCuoi < ADSGRAM_CHO_TOI_THIEU_MS) {
    return Response.json({ thanh_cong: false, loi: "cho_qua_nhanh" });
  }

  const soLanMoi = soLanDaXem + 1;
  await env.USERS.put(key, String(soLanMoi));
  await env.USERS.put(keyLanCuoi, String(now));

  const soCoinCong = Number(env.THUONG_COIN_ADSGRAM || 500); // nếu đã đặt biến môi trường THUONG_COIN_ADSGRAM trên Worker thì cần cập nhật giá trị đó luôn, vì nó được ưu tiên hơn số mặc định này
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_QUANG_CAO);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_adsgram_da_xem: soLanMoi,
    adsgram_gioi_han_ngay: ADSGRAM_GIOI_HAN_NGAY,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
  });
}

// ==================================================
// 📅 ĐIỂM DANH CHUỖI NGÀY — thưởng coin tăng dần theo 7 ngày liên tiếp,
// đứt quãng (bỏ lỡ 1 ngày) thì chuỗi reset về 1. Chu kỳ 7 ngày lặp lại
// (ngày 8 tính thưởng như ngày 1, v.v.)
// ==================================================
async function layDiemDanh(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_DIEM_DANH + uid);
  return raw ? JSON.parse(raw) : { chuoi_hien_tai: 0, ngay_cuoi: null };
}

async function luuDiemDanh(env, uid, duLieu) {
  await env.USERS.put(TIEN_TO_DIEM_DANH + uid, JSON.stringify(duLieu));
}

// Chỉ đọc trạng thái — dùng khi mở tab / làm mới định kỳ, KHÔNG cộng thưởng
async function xuLyThongTinDiemDanh(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const dd = await layDiemDanh(env, uid);

  return Response.json({
    thanh_cong: true,
    chuoi_hien_tai: dd.chuoi_hien_tai || 0,
    da_diem_danh_hom_nay: dd.ngay_cuoi === homNay,
    thuong: THUONG_DIEM_DANH,
  });
}

// Điểm danh — cộng thưởng coin theo vị trí trong chu kỳ 7 ngày
async function xuLyDiemDanh(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const dd = await layDiemDanh(env, uid);

  if (dd.ngay_cuoi === homNay) {
    return Response.json({
      thanh_cong: false,
      loi: "da_diem_danh_hom_nay",
      chuoi_hien_tai: dd.chuoi_hien_tai || 0,
      thuong: THUONG_DIEM_DANH,
    });
  }

  const homQua = ngayTruocVN(homNay);
  const chuoiMoi = dd.ngay_cuoi === homQua ? (dd.chuoi_hien_tai || 0) + 1 : 1;

  const viTriThuong = (chuoiMoi - 1) % THUONG_DIEM_DANH.length;
  const soCoinCong = THUONG_DIEM_DANH[viTriThuong];

  await luuDiemDanh(env, uid, { chuoi_hien_tai: chuoiMoi, ngay_cuoi: homNay });

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    chuoi_hien_tai: chuoiMoi,
    thuong: THUONG_DIEM_DANH,
  });
}

// Bắt đầu 1 phiên đào coin mới (nút "Đào Coin" ở Trang chủ) — chỉ cho bắt
// đầu khi hiện KHÔNG có phiên nào đang chạy. Phiên chạy liên tục tối đa
// THOI_GIAN_DAO_MS (4 giờ) kể cả khi người dùng thoát app, coin được tính
// bù (credit dồn) ở lần gọi /trang-thai-dao kế tiếp.
async function xuLyBatDauDao(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };

  // Nếu đang có phiên chưa credit hết (vd vừa hết hạn nhưng chưa poll lần
  // cuối) thì credit nốt trước, tránh mất coin của phiên cũ. batBuoc=true vì
  // object `dao` sắp bị ghi đè bằng phiên mới ngay bên dưới — không thể để
  // dành sang lần chốt định kỳ tiếp theo như lúc poll bình thường được.
  await xuLyCreditDaoNeuCo(env, uid, nguoiDung, true);

  if (nguoiDung.dao && nguoiDung.dao.dangDao) {
    await luuNguoiDung(env, uid, nguoiDung);
    return Response.json({ thanh_cong: false, loi: "dang_dao_roi", ...thongTinDaoDeTra(nguoiDung) });
  }

  const bayGio = Date.now();
  nguoiDung.dao = { dangDao: true, batDauLuc: bayGio, ketThucLuc: bayGio + THOI_GIAN_DAO_MS, lanCuoiCongLuc: bayGio };
  await luuNguoiDung(env, uid, nguoiDung);

  return Response.json({ thanh_cong: true, ...thongTinDaoDeTra(nguoiDung) });
}

// Trạng thái đào — gọi định kỳ (poll) để: (1) credit phần coin phát sinh kể
// từ lần gọi trước, giúp số coin "cộng dần theo thời gian thực"; (2) trả về
// cấp độ / XP / tốc độ đào / thời gian còn lại của phiên hiện tại (nếu có).
async function xuLyTrangThaiDao(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = await layNguoiDung(env, uid);
  if (!nguoiDung) return Response.json(thongTinDaoDeTra({ coin: 0 }));

  // Đa số lượt gọi (poll mỗi 20-30s từ client) sẽ rơi vào trường hợp
  // daGhi=false — tức KHÔNG tốn write KV nào, vì chưa đủ
  // KHOANG_CACH_TOI_THIEU_GHI_DAO_MS kể từ lần chốt sổ trước. Chỉ khi đủ
  // khoảng cách (hoặc phiên vừa kết thúc) mới thực sự ghi.
  const { daGhi } = await xuLyCreditDaoNeuCo(env, uid, nguoiDung);
  if (daGhi) {
    await luuNguoiDung(env, uid, nguoiDung);
  }

  return Response.json(thongTinDaoDeTra(nguoiDung));
}

// Reset mã — hủy nhiệm vụ đang chờ (CHƯA hoàn thành) để tạo lại link mới,
// dùng khi lỡ mất mã/đóng nhầm trang đích. Không cho reset nếu đã xong
// hôm nay rồi, tránh lách giới hạn ngày.
async function xuLyResetNhiemVu(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_LINK4M_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= LINK4M_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_hoan_thanh_khong_the_reset" });
  }

  const dangCho = await layNhiemVuHienTai(env, uid);
  if (!dangCho || dangCho.ngay !== homNay) {
    return Response.json({ thanh_cong: false, loi: "khong_co_gi_de_reset" });
  }

  await xoaNhiemVuHienTai(env, uid);
  return Response.json({ thanh_cong: true });
}

// Màn hình "Đang bảo trì" — trả về khi chế độ bảo trì đang BẬT, dùng chung
// bảng màu tối với miniapp chính để nhất quán trải nghiệm.
function trangBaoTri() {
  return new Response(
    `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Đang bảo trì</title>
<style>
  :root {
    --tg-blue: #229ED9;
    --tg-dark: #0A0E1A;
    --tg-surface: #0F1629;
    --tg-border: rgba(34, 158, 217, 0.18);
    --tg-text: #E8EDF5;
    --tg-muted: #5A7A99;
    --tg-glow: rgba(34, 158, 217, 0.35);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; min-height: 100%;
    background: var(--tg-dark);
    font-family: -apple-system, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
    color: var(--tg-text);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px;
    background: var(--tg-surface);
    border: 1px solid var(--tg-border);
    border-radius: 24px;
    padding: 40px 30px;
    text-align: center;
    box-shadow: 0 0 40px rgba(34, 158, 217, 0.08);
  }
  .icon-wrap {
    width: 76px; height: 76px; border-radius: 50%;
    background: radial-gradient(circle at 40% 38%, rgba(245,185,66,0.18), transparent 70%);
    border: 1.5px solid rgba(245,185,66,0.3);
    display: flex; align-items: center; justify-content: center;
    font-size: 34px;
    margin: 0 auto 22px;
    animation: lac 2.4s ease-in-out infinite;
  }
  @keyframes lac {
    0%, 100% { transform: rotate(-6deg); }
    50% { transform: rotate(6deg); }
  }
  h1 { font-size: 21px; font-weight: 700; margin-bottom: 12px; letter-spacing: -0.01em; }
  p { color: var(--tg-muted); font-size: 14px; line-height: 1.7; margin-bottom: 22px; }
  .dots span {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--tg-blue); margin: 0 3px;
    animation: bounce 1.2s ease-in-out infinite; opacity: 0.4;
  }
  .dots span:nth-child(2) { animation-delay: 0.2s; }
  .dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
    40% { transform: translateY(-6px); opacity: 1; }
  }
  .badge {
    display: inline-flex; align-items: center; gap: 7px; margin-top: 20px;
    padding: 9px 18px; border-radius: 40px;
    background: rgba(34,158,217,0.08); border: 1px solid var(--tg-border);
    font-size: 12.5px; color: var(--tg-blue); font-weight: 600;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon-wrap">🛠️</div>
    <h1>Đang bảo trì</h1>
    <p>Vua Cày Tiền đang được nâng cấp để phục vụ bạn tốt hơn.<br/>Vui lòng quay lại sau ít phút nhé!</p>
    <div class="dots"><span></span><span></span><span></span></div>
    <div class="badge">💰 Coin và dữ liệu của bạn vẫn an toàn</div>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function trangHtmlMa({ icon, tieuDe, ma, moTa, ghiChu }) {
  const khoiMa = ma
    ? `<div class="ma" id="ma">${ma}</div>
       <button class="btn-copy" id="btn-copy" type="button">
         <span id="btn-copy-label">📋 Copy mã</span>
       </button>`
    : "";

  const script = ma
    ? `<script>
        document.getElementById('btn-copy').addEventListener('click', function () {
          var ma = document.getElementById('ma').textContent;
          var xongRoi = function () {
            var label = document.getElementById('btn-copy-label');
            var cu = label.textContent;
            label.textContent = '✅ Đã copy';
            setTimeout(function () { label.textContent = cu; }, 1500);
          };
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(ma).then(xongRoi);
          } else {
            var ta = document.createElement('textarea');
            ta.value = ma;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
            xongRoi();
          }
        });
      </script>`
    : "";

  return new Response(
    `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${tieuDe}</title>
<style>
  :root {
    --tg-blue: #229ED9;
    --tg-dark: #0A0E1A;
    --tg-surface: #0F1629;
    --tg-border: rgba(34, 158, 217, 0.18);
    --tg-text: #E8EDF5;
    --tg-muted: #5A7A99;
    --tg-glow: rgba(34, 158, 217, 0.35);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; min-height: 100%;
    background: var(--tg-dark);
    font-family: -apple-system, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
    color: var(--tg-text);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px;
    background: var(--tg-surface);
    border: 1px solid var(--tg-border);
    border-radius: 24px;
    padding: 36px 28px;
    text-align: center;
    box-shadow: 0 0 40px rgba(34, 158, 217, 0.08);
  }
  .icon {
    width: 72px; height: 72px;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 38%, rgba(34,158,217,0.22), transparent 70%);
    border: 1.5px solid var(--tg-border);
    display: flex; align-items: center; justify-content: center;
    font-size: 32px;
    margin: 0 auto 20px;
  }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 20px; }
  .ma {
    font-size: 42px; font-weight: 700; letter-spacing: 8px;
    color: var(--tg-blue);
    text-shadow: 0 0 20px var(--tg-glow);
    margin-bottom: 24px;
    word-break: break-all;
  }
  p { color: var(--tg-muted); font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
  .btn-copy {
    width: 100%;
    background: var(--tg-blue);
    color: #fff;
    border: none;
    border-radius: 14px;
    padding: 16px;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
  }
  .btn-copy:active { opacity: 0.85; }
  .ghi-chu { color: var(--tg-muted); font-size: 12px; margin-top: 16px; margin-bottom: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${tieuDe}</h1>
    ${khoiMa}
    <p style="${ma ? "" : "margin-bottom:0;"}">${moTa}</p>
    ${ghiChu ? `<p class="ghi-chu">${ghiChu}</p>` : ""}
  </div>
  ${script}
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function xuLyTrangNhiemVu(env, ma) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU + ma);
  if (!raw) {
    return trangHtmlMa({
      icon: "❌",
      tieuDe: "Mã không hợp lệ",
      moTa: "Mã này không tồn tại hoặc đã bị xóa. Quay lại app tạo nhiệm vụ mới.",
    });
  }

  const banGhi = JSON.parse(raw);
  if (banGhi.daDung) {
    return trangHtmlMa({
      icon: "✅",
      tieuDe: "Mã đã dùng",
      moTa: "Mã này đã được xác nhận trước đó rồi.",
    });
  }
  if (Date.now() - banGhi.taoLuc > TTL_NHIEM_VU_MS) {
    return trangHtmlMa({
      icon: "⏰",
      tieuDe: "Mã đã hết hạn",
      moTa: "Nhiệm vụ này đã hết hạn. Quay lại app tạo nhiệm vụ mới.",
    });
  }

  return trangHtmlMa({
    icon: "🎯",
    tieuDe: "Mã xác nhận",
    ma,
    moTa: "Copy mã này và nhập vào mục Rút gọn trong game để nhận thưởng.",
    ghiChu: "Mã có hiệu lực 30 phút sau khi tạo link",
  });
}

async function xuLyXacNhanNhiemVu(env, url) {
  const uid = url.searchParams.get("uid");
  const ma = url.searchParams.get("ma");
  if (!uid || !ma) return Response.json({ hoan_thanh: false, loi: "thieu_tham_so" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chốt chặn thật — dù có lách qua bước tạo link thế nào cũng dừng ở đây
  const keySoLan = TIEN_TO_LINK4M_SO_LAN_NGAY + uid + ":" + homNay;
  const soLanDaXong = Number((await env.USERS.get(keySoLan)) || 0);
  if (soLanDaXong >= LINK4M_GIOI_HAN_NGAY) {
    return Response.json({ hoan_thanh: false, loi: "da_vuot_hom_nay" });
  }

  const key = TIEN_TO_NHIEM_VU + ma;
  const raw = await env.USERS.get(key);
  if (!raw) return Response.json({ hoan_thanh: false, loi: "sai_ma" });

  const banGhi = JSON.parse(raw);
  if (banGhi.uid !== String(uid)) return Response.json({ hoan_thanh: false, loi: "sai_ma" });
  if (banGhi.daDung) return Response.json({ hoan_thanh: false, loi: "da_dung" });
  if (Date.now() - banGhi.taoLuc > TTL_NHIEM_VU_MS) return Response.json({ hoan_thanh: false, loi: "het_han" });

  banGhi.daDung = true;
  await env.USERS.put(key, JSON.stringify(banGhi));
  const soLanMoi = soLanDaXong + 1;
  await env.USERS.put(keySoLan, String(soLanMoi));
  await env.USERS.put(TIEN_TO_LINK4M_LAN_CUOI + uid, String(Date.now())); // mốc chặn vượt liên tục, phải chờ LINK4M_CHO_TOI_THIEU_MS mới được vượt tiếp
  await xoaNhiemVuHienTai(env, uid); // dọn con trỏ, nhiệm vụ này xong rồi

  // Cộng thưởng coin
  const soCoinCong = Number(env.THUONG_COIN_NHIEM_VU || 2500); // nếu đã đặt biến môi trường THUONG_COIN_NHIEM_VU trên Worker thì cần cập nhật giá trị đó luôn, vì nó được ưu tiên hơn số mặc định này
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_VUOT_LINK); // +15 XP đào/lượt vượt link
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    hoan_thanh: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_link4m_da_xong: soLanMoi,
    link4m_gioi_han_ngay: LINK4M_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: LINK4M_CHO_TOI_THIEU_MS / 1000,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
  });
}

// Nhập gift code — mỗi mã dùng chung cho nhiều người (tối đa
// soLuongToiDa lượt), mỗi user chỉ được nhập ĐÚNG 1 mã 1 lần (đánh dấu
// bằng key riêng gifcode-da-dung:{ma}:{uid} để chặn nhập lại kể cả khi
// mã còn lượt).
async function xuLyNhapGifcode(env, url) {
  const uid = url.searchParams.get("uid");
  const maTho = url.searchParams.get("code");
  if (!uid || !maTho) return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });

  const ma = maTho.trim().toUpperCase();
  if (!ma) return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });

  const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
  if (!raw) return Response.json({ thanh_cong: false, loi: "ma_khong_ton_tai" });

  const giftcode = JSON.parse(raw);

  const keyDaDung = TIEN_TO_GIFCODE_DA_DUNG + ma + ":" + uid;
  const daDungRoi = await env.USERS.get(keyDaDung);
  if (daDungRoi) return Response.json({ thanh_cong: false, loi: "da_nhap_roi" });

  if ((giftcode.soLuongDaDung || 0) >= giftcode.soLuongToiDa) {
    return Response.json({ thanh_cong: false, loi: "het_luot" });
  }

  // Đánh dấu đã dùng TRƯỚC khi cộng coin, để nếu có lỗi giữa chừng cũng
  // không cộng coin 2 lần cho cùng 1 user với cùng 1 mã.
  await env.USERS.put(keyDaDung, String(Date.now()));
  giftcode.soLuongDaDung = (giftcode.soLuongDaDung || 0) + 1;
  await env.USERS.put(TIEN_TO_GIFCODE + ma, JSON.stringify(giftcode));

  // Random số coin nhận được trong khoảng [coinMin, coinMax] của mã — nếu
  // admin tạo mã với số cố định thì coinMin === coinMax, luôn ra đúng số đó.
  const soCoinNhanDuoc = ngauNhienCoinTrongKhoang(giftcode.coinMin, giftcode.coinMax);

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinNhanDuoc;
  congCoin(nguoiDung, soCoinNhanDuoc);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinNhanDuoc);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinNhanDuoc,
    ma,
  });
}

// ==================================================
// 🏆 BẢNG XẾP HẠNG — "Đua Top Xu": xếp theo XU KIẾM ĐƯỢC TRONG MÙA GIẢI
// hiện tại. Chỉ Top 10 mới nhận phần thưởng khi kết thúc mùa giải.
//
// Điểm số tính THEO MÙA (không phải lũy kế toàn thời gian): mỗi user lưu 1
// "mốc mùa giải" (mocMuaGiai) chụp lại tongDaKiem tại thời điểm mùa hiện
// tại bắt đầu quét user đó lần đầu (lazy — chỉ ghi lại khi phát hiện số
// mùa đã đổi). Điểm hiển thị = giá trị lũy kế hiện tại − giá trị tại mốc.
// Nhờ vậy KHÔNG cần sửa mọi nơi cộng coin trong toàn bộ file, mùa mới tự
// "reset" điểm về 0 ngay lần quét đầu tiên của mùa đó.
//
// Để tránh quét toàn bộ KV (tốn CPU time) mỗi lần người dùng mở app, bảng
// được TÍNH TRƯỚC và lưu vào cache, làm mới mỗi 15 phút bằng Cron Trigger
// (xem "scheduled" ở cuối file + [triggers] trong wrangler.toml).
// Endpoint /bang-xep-hang chỉ đọc cache; nếu chưa có cache (lần đầu deploy)
// thì tính trực tiếp 1 lần để không trả về rỗng.
// ==================================================
const MUC_TOI_THIEU_KIEM_XU = 5000; // xu tối thiểu kiếm được TRONG MÙA để được xếp vào BXH Đua Top Xu

// Đảm bảo user có mốc mùa giải khớp với mùa hiện tại — nếu chưa có hoặc
// mùa đã đổi thì chụp lại số coin hiện tại làm mốc 0 của mùa mới.
async function damBaoMocMuaGiai(env, uid, nguoiDung, soMuaHienTai) {
  let moc = nguoiDung.mocMuaGiai;
  if (!moc || moc.so_mua !== soMuaHienTai) {
    const coinHienTai = nguoiDung.tongDaKiem != null ? nguoiDung.tongDaKiem : nguoiDung.coin || 0;
    moc = { so_mua: soMuaHienTai, coin_goc: coinHienTai };
    nguoiDung.mocMuaGiai = moc;
    await luuNguoiDung(env, uid, nguoiDung);
  }
  return moc;
}

async function tinhBangXepHangKiemXu(env, soMuaHienTai) {
  const QUET_TOI_DA = 50; // giảm từ 100 → 50 — cron 15 phút/lần × quét lớn từng gần chạm trần 100k đọc KV/ngày dù CHƯA có user thật nào gọi API; xem ghi chú ở lamMoiCacheBangXepHang
  const ketQua = [];
  let daQuet = 0;

  try {
    for await (const uid of duyetTatCaNguoiDung(env)) {
      if (daQuet >= QUET_TOI_DA) break;
      daQuet += 1;
      const nguoiDung = await layNguoiDung(env, uid);
      if (!nguoiDung) continue;

      const coinHienTai = nguoiDung.tongDaKiem != null ? nguoiDung.tongDaKiem : nguoiDung.coin || 0;
      const moc = await damBaoMocMuaGiai(env, uid, nguoiDung, soMuaHienTai);
      const daKiemTrongMua = Math.max(0, coinHienTai - moc.coin_goc);
      if (daKiemTrongMua < MUC_TOI_THIEU_KIEM_XU) continue;

      const tenHienThi = (nguoiDung.ten && nguoiDung.ten.trim()) || (nguoiDung.username ? `@${nguoiDung.username}` : "");
      if (!tenHienThi) continue;

      ketQua.push({ uid, ten: tenHienThi, gia_tri: daKiemTrongMua });
    }
  } catch (e) {
    // Có thể do vượt giới hạn subrequest/KV giữa chừng — dừng lại và trả về
    // những gì đã quét được thay vì làm hỏng toàn bộ bảng xếp hạng.
  }

  ketQua.sort((a, b) => b.gia_tri - a.gia_tri);
  return ketQua.slice(0, 50);
}

// Tính lại + ghi cache — được gọi bởi Cron Trigger mỗi 15 phút.
async function lamMoiCacheBangXepHang(env, muaGiai) {
  const mg = muaGiai || (await layHoacTaoMuaGiai(env));
  const kiemXu = await tinhBangXepHangKiemXu(env, mg.so);
  const duLieu = { so_mua: mg.so, kiem_xu: kiemXu, cap_nhat_luc: Date.now() };
  try {
    await env.USERS.put(KEY_CACHE_BANG_XEP_HANG, JSON.stringify(duLieu));
  } catch (e) {
    console.error("Không ghi được cache-bang-xep-hang vào KV (có thể hết quota put()/ngày):", e);
  }
  return duLieu;
}

// Mùa giải BXH — lưu số mùa + mốc bắt đầu/kết thúc trong KV. Tự động mở
// mùa mới ngay khi phát hiện mùa hiện tại đã hết hạn (đọc lazy, không cần
// cron riêng). Khi kết thúc mùa, admin trao thưởng Top 10 thủ công (tương
// tự quy trình duyệt rút tiền) rồi mùa mới tự mở ở lượt đọc kế tiếp —
// điểm 2 bảng tự về 0 nhờ cơ chế mốc mùa giải ở trên.
async function layHoacTaoMuaGiai(env) {
  const raw = await env.USERS.get(KEY_MUA_GIAI);
  const bayGio = Date.now();
  const doDaiToiDaHopLeMs = MUA_GIAI_SO_NGAY * 24 * 60 * 60 * 1000;

  if (raw) {
    const mg = JSON.parse(raw);
    // Dữ liệu hợp lệ: có số mùa hợp lệ + còn hạn + KHÔNG dài hơn cấu hình
    // MUA_GIAI_SO_NGAY hiện tại (tránh trường hợp mùa cũ được tạo từ lúc
    // cấu hình còn dài hơn — vd 20-30 ngày — trước khi đổi về 7 ngày, mà
    // ket_thuc cũ vẫn còn hạn nên bị giữ nguyên mãi không áp dụng số mới).
    const conHan = mg.ket_thuc > bayGio;
    const soHopLe = Number.isFinite(mg.so) && mg.so > 0;
    const doDaiHopLe = mg.ket_thuc - (mg.bat_dau || bayGio) <= doDaiToiDaHopLeMs;
    if (conHan && soHopLe && doDaiHopLe) return mg;

    const moi = { so: soHopLe ? mg.so + (conHan ? 0 : 1) : 1, bat_dau: bayGio, ket_thuc: bayGio + doDaiToiDaHopLeMs };
    await env.USERS.put(KEY_MUA_GIAI, JSON.stringify(moi));
    return moi;
  }
  const moi = { so: 1, bat_dau: bayGio, ket_thuc: bayGio + doDaiToiDaHopLeMs };
  await env.USERS.put(KEY_MUA_GIAI, JSON.stringify(moi));
  return moi;
}

// Tính phần thưởng hiển thị cho 1 hạng của BXH Đua Top Xu.
function tinhPhanThuong(hang) {
  if (hang > TOP_NHAN_THUONG) return { coin: 0 };
  return { coin: PHAN_THUONG_KIEM_XU[hang - 1] };
}

async function xuLyBangXepHang(env, url, ctx) {
  const loai = "kiem_xu";
  const uid = url.searchParams.get("uid");

  try {
    const muaGiai = await layHoacTaoMuaGiai(env);

    const raw = await env.USERS.get(KEY_CACHE_BANG_XEP_HANG);
    let cache = raw ? JSON.parse(raw) : null;

    if (!cache) {
      // Chưa từng có cache (lần đầu deploy) — bắt buộc tính ngay 1 lần để
      // không trả về rỗng mãi (giới hạn quét đã được hạ thấp ở 2 hàm tính
      // để tránh vượt subrequest ngay trong request đầu tiên này).
      cache = await lamMoiCacheBangXepHang(env, muaGiai);
    } else if (cache.so_mua !== muaGiai.so) {
      // Cache thuộc mùa cũ — trả cache cũ ngay cho nhanh (không chặn user
      // chờ tính lại), rồi âm thầm làm mới ở nền qua waitUntil. Cache cũ
      // vẫn hiển thị được (chỉ hơi lệch số mùa 1 nhịp, sẽ tự đúng lại sau).
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(lamMoiCacheBangXepHang(env, muaGiai).catch(() => {}));
      } else {
        cache = await lamMoiCacheBangXepHang(env, muaGiai);
      }
    }

    const danhSach = cache[loai] || [];

    let hangCuaToi = null;
    let giaTriCuaToi = 0;
    if (uid) {
      const idx = danhSach.findIndex((nd) => String(nd.uid) === String(uid));
      if (idx >= 0) {
        hangCuaToi = idx + 1;
        giaTriCuaToi = danhSach[idx].gia_tri;
      } else {
        try {
          const nd = await layNguoiDung(env, uid);
          if (nd) {
            const moc = await damBaoMocMuaGiai(env, uid, nd, muaGiai.so);
            const coinHienTai = nd.tongDaKiem != null ? nd.tongDaKiem : nd.coin || 0;
            giaTriCuaToi = Math.max(0, coinHienTai - moc.coin_goc);
          }
        } catch (e) {
          // Không tính được hạng riêng của user (vd hết subrequest) — bỏ
          // qua, vẫn trả về được bảng xếp hạng chung bên dưới.
        }
      }
    }

    return Response.json({
      mua_giai: muaGiai,
      loai,
      don_vi_gia_tri: "xu",
      muc_toi_thieu_bxh: MUC_TOI_THIEU_KIEM_XU,
      top_nhan_thuong: TOP_NHAN_THUONG,
      bang_thuong: Array.from({ length: TOP_NHAN_THUONG }, (_, i) => ({ hang: i + 1, coin: PHAN_THUONG_KIEM_XU[i] })),
      bang_xep_hang: danhSach.map((nd, idx) => ({
        hang: idx + 1,
        uid: nd.uid,
        ten: nd.ten,
        gia_tri: nd.gia_tri,
        phan_thuong: tinhPhanThuong(idx + 1),
      })),
      hang_cua_toi: hangCuaToi,
      gia_tri_cua_toi: giaTriCuaToi,
      cap_nhat_luc: cache.cap_nhat_luc,
    });
  } catch (e) {
    // An toàn tuyệt đối: bất kể lỗi gì xảy ra (vượt subrequest, KV timeout,
    // v.v.), KHÔNG để lỗi 500 lộ ra frontend — trả về 200 với dữ liệu rỗng
    // để giao diện vẫn hiển thị bình thường (thay vì "Không tải được...").
    return Response.json({
      mua_giai: { so: 0, bat_dau: Date.now(), ket_thuc: Date.now() },
      loai,
      don_vi_gia_tri: "xu",
      muc_toi_thieu_bxh: MUC_TOI_THIEU_KIEM_XU,
      top_nhan_thuong: TOP_NHAN_THUONG,
      bang_thuong: [],
      bang_xep_hang: [],
      hang_cua_toi: null,
      gia_tri_cua_toi: 0,
      cap_nhat_luc: Date.now(),
      loi: "tam_thoi_khong_tai_duoc",
    });
  }
}

// ==================================================
// 💰 VÍ & RÚT TIỀN — không tự động chuyển khoản, chỉ ghi nhận yêu cầu
// và báo admin xử lý thủ công. Mọi giới hạn (tối thiểu, ngày, tuần,
// khóa 1 tài khoản nhận duy nhất) được enforce ở SERVER, không tin
// client — vì đây là chỗ liên quan trực tiếp tới tiền thật.
// ==================================================
// ==================================================
// 👥 BẠN BÈ — ghi nhận lượt mời qua link ref_, tra cứu cho tab Bạn bè
// ==================================================

async function ghiNhanBanBeMoi(env, refUid, banMoi) {
  const key = TIEN_TO_BAN_BE + refUid;
  const raw = await env.USERS.get(key);
  const danhSach = raw ? JSON.parse(raw) : [];
  danhSach.unshift(banMoi); // mới nhất lên đầu
  await env.USERS.put(key, JSON.stringify(danhSach.slice(0, 200))); // giới hạn 200 bản ghi gần nhất
}

// +80 coin cho người mời khi mời được 1 người bạn mới tham gia thành công
// (chỉ tính 1 lần/người được mời, do chỉ gọi khi laNguoiDungMoi === true)
async function congThuongMoiBanThanhCong(env, refUid) {
  const nguoiGioiThieu = await layNguoiDung(env, refUid);
  if (!nguoiGioiThieu) return;
  nguoiGioiThieu.coin = (nguoiGioiThieu.coin || 0) + THUONG_MOI_BAN_THANH_CONG;
  nguoiGioiThieu.tongDaKiem = (nguoiGioiThieu.tongDaKiem || 0) + THUONG_MOI_BAN_THANH_CONG;
  nguoiGioiThieu.coinTuBanBe = (nguoiGioiThieu.coinTuBanBe || 0) + THUONG_MOI_BAN_THANH_CONG; // cộng dồn riêng "coin kiếm được từ bạn bè", hiển thị ở tab Bạn bè
  await luuNguoiDung(env, refUid, nguoiGioiThieu);
}

async function xuLyThongTinBanBe(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const raw = await env.USERS.get(TIEN_TO_BAN_BE + uid);
  const danhSach = raw ? JSON.parse(raw) : [];
  const nguoiDung = await layNguoiDung(env, uid);

  return Response.json({
    so_luong: danhSach.length,
    coin_tu_ban_be: nguoiDung ? nguoiDung.coinTuBanBe || 0 : 0, // tổng coin kiếm được từ bạn bè (thưởng mời thành công + hoa hồng nhiều tầng)
    danh_sach: danhSach.map((nb) => ({ ten: nb.ten, tham_gia_luc: nb.thamGiaLuc })),
  });
}

async function xuLyThongTinVi(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = await layNguoiDung(env, uid);
  const coin = nguoiDung ? nguoiDung.coin || 0 : 0;

  const rawTaiKhoan = await env.USERS.get(TIEN_TO_TAI_KHOAN_NHAN + uid);
  const taiKhoan = rawTaiKhoan ? JSON.parse(rawTaiKhoan) : null;

  let coTheDoiTaiKhoan = true;
  let soNgayConLaiDeDoi = 0;
  if (taiKhoan && taiKhoan.capNhatLuc) {
    const soNgayDaTroi = (Date.now() - taiKhoan.capNhatLuc) / (24 * 60 * 60 * 1000);
    if (soNgayDaTroi < SO_NGAY_DOI_TAI_KHOAN) {
      coTheDoiTaiKhoan = false;
      soNgayConLaiDeDoi = Math.ceil(SO_NGAY_DOI_TAI_KHOAN - soNgayDaTroi);
    }
  }

  const homNay = ngayVnHomNay();
  const tuanNay = dauTuanVN();
  const daRutNgay = Number((await env.USERS.get(TIEN_TO_RUT_NGAY + uid + ":" + homNay)) || 0);
  const daRutTuan = Number((await env.USERS.get(TIEN_TO_RUT_TUAN + uid + ":" + tuanNay)) || 0);
  const soLanDaRutHomNay = Number((await env.USERS.get(TIEN_TO_SO_LAN_RUT_NGAY + uid + ":" + homNay)) || 0);

  const lichSu = await layLichSuRutTien(env, uid);

  return Response.json({
    coin: coin,
    coin_quy_doi_dong_mau_so: COIN_QUY_DOI_DONG_MAU_SO,
    rut_toi_thieu: RUT_TOI_THIEU,
    tai_khoan: taiKhoan,
    co_the_doi_tai_khoan: coTheDoiTaiKhoan,
    so_ngay_con_lai_de_doi: soNgayConLaiDeDoi,
    con_lai_ngay: Math.max(0, RUT_TOI_DA_NGAY - daRutNgay),
    con_lai_tuan: Math.max(0, RUT_TOI_DA_TUAN - daRutTuan),
    so_lan_rut_toi_da_ngay: SO_LAN_RUT_TOI_DA_NGAY,
    da_rut_hom_nay: soLanDaRutHomNay >= SO_LAN_RUT_TOI_DA_NGAY, // true = đã dùng hết lượt rút trong ngày, ẩn/khóa nút rút ở frontend
    lich_su_rut: lichSu,
  });
}

// Lấy lịch sử giao dịch rút tiền của 1 user, mới nhất trước, tối đa 20 giao dịch
async function layLichSuRutTien(env, uid) {
  const tienTo = TIEN_TO_GIAO_DICH_RUT + uid + ":";
  const trang = await env.USERS.list({ prefix: tienTo, limit: 100 });
  const ketQua = [];
  for (const key of trang.keys) {
    const raw = await env.USERS.get(key.name);
    if (raw) ketQua.push(JSON.parse(raw));
  }
  ketQua.sort((a, b) => b.taoLuc - a.taoLuc);
  return ketQua.slice(0, 20);
}

async function xuLyYeuCauRutTien(env, url) {
  const uid = url.searchParams.get("uid");
  const nganHang = (url.searchParams.get("ngan_hang") || "").trim();
  const soTk = (url.searchParams.get("so_tk") || "").trim();
  const tenNguoiNhan = (url.searchParams.get("ten_nguoi_nhan") || "").trim();
  const soCoin = Number(url.searchParams.get("so_coin"));

  if (!uid || !nganHang || !soTk || !tenNguoiNhan || !soCoin) {
    return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });
  }
  if (!Number.isFinite(soCoin) || !Number.isInteger(soCoin) || soCoin < RUT_TOI_THIEU) {
    return Response.json({ thanh_cong: false, loi: "duoi_toi_thieu" });
  }

  const nguoiDung = await layNguoiDung(env, uid);
  const coinHienCo = nguoiDung ? nguoiDung.coin || 0 : 0;
  if (soCoin > coinHienCo) {
    return Response.json({ thanh_cong: false, loi: "khong_du_coin" });
  }

  const soPhi = Math.floor(soCoin * PHI_RUT_TIEN_PHAN_TRAM); // phí dịch vụ 10% tính theo coin
  const soTien = Math.floor((soCoin - soPhi) / COIN_QUY_DOI_DONG_MAU_SO); // số tiền THỰC NHẬN (đã trừ phí) để admin chuyển khoản

  // Cho phép đổi sang tài khoản nhận khác, nhưng chỉ 1 lần mỗi
  // SO_NGAY_DOI_TAI_KHOAN ngày — chống việc đổi liên tục để né kiểm soát.
  const rawTaiKhoan = await env.USERS.get(TIEN_TO_TAI_KHOAN_NHAN + uid);
  const taiKhoanDaLuu = rawTaiKhoan ? JSON.parse(rawTaiKhoan) : null;
  const laDoiTaiKhoan = taiKhoanDaLuu && (taiKhoanDaLuu.nganHang !== nganHang || taiKhoanDaLuu.soTk !== soTk);
  if (laDoiTaiKhoan) {
    const soNgayDaTroi = (Date.now() - (taiKhoanDaLuu.capNhatLuc || 0)) / (24 * 60 * 60 * 1000);
    if (soNgayDaTroi < SO_NGAY_DOI_TAI_KHOAN) {
      return Response.json({
        thanh_cong: false,
        loi: "chua_du_ngay_de_doi_tai_khoan",
        so_ngay_con_lai_de_doi: Math.ceil(SO_NGAY_DOI_TAI_KHOAN - soNgayDaTroi),
      });
    }
  }

  const homNay = ngayVnHomNay();
  const tuanNay = dauTuanVN();
  const keyNgay = TIEN_TO_RUT_NGAY + uid + ":" + homNay;
  const keyTuan = TIEN_TO_RUT_TUAN + uid + ":" + tuanNay;
  const keySoLanNgay = TIEN_TO_SO_LAN_RUT_NGAY + uid + ":" + homNay;
  const daRutNgay = Number((await env.USERS.get(keyNgay)) || 0);
  const daRutTuan = Number((await env.USERS.get(keyTuan)) || 0);
  const soLanDaRut = Number((await env.USERS.get(keySoLanNgay)) || 0);

  // Chỉ cho gửi tối đa SO_LAN_RUT_TOI_DA_NGAY (1) yêu cầu rút / ngày —
  // kiểm tra riêng, độc lập với hạn mức coin/ngày ở dưới.
  if (soLanDaRut >= SO_LAN_RUT_TOI_DA_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_so_lan_rut_hom_nay" });
  }
  if (daRutNgay + soCoin > RUT_TOI_DA_NGAY) {
    return Response.json({ thanh_cong: false, loi: "vuot_han_muc_ngay" });
  }
  if (daRutTuan + soCoin > RUT_TOI_DA_TUAN) {
    return Response.json({ thanh_cong: false, loi: "vuot_han_muc_tuan" });
  }

  // Trừ coin ngay — coi như coin bị giữ lại chờ admin xử lý thủ công,
  // tránh gửi trùng nhiều yêu cầu vượt quá số coin thực có.
  nguoiDung.coin = coinHienCo - soCoin;
  await luuNguoiDung(env, uid, nguoiDung);

  if (!taiKhoanDaLuu || laDoiTaiKhoan) {
    await env.USERS.put(
      TIEN_TO_TAI_KHOAN_NHAN + uid,
      JSON.stringify({ nganHang, soTk, tenNguoiNhan, capNhatLuc: Date.now() })
    );
  }
  await env.USERS.put(keyNgay, String(daRutNgay + soCoin));
  await env.USERS.put(keyTuan, String(daRutTuan + soCoin));
  await env.USERS.put(keySoLanNgay, String(soLanDaRut + 1));

  // Tạo bản ghi giao dịch — trạng thái "cho_duyet" cho tới khi admin xử lý
  // trên trang web quản lý rút tiền. Từ chối thì hoàn tiền cho user.
  const idGiaoDich = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const giaoDich = {
    id: idGiaoDich,
    uid: String(uid),
    nganHang,
    soTk,
    tenNguoiNhan,
    soCoin,
    soPhi, // phí dịch vụ 10%, tính theo coin (đã trừ vào soTien bên dưới)
    soTien, // số tiền THỰC NHẬN, đã trừ phí 10% — để admin chuyển khoản
    trangThai: "cho_duyet",
    taoLuc: Date.now(),
    keyNgay,
    keyTuan,
    keySoLanNgay,
  };
  await env.USERS.put(TIEN_TO_GIAO_DICH_RUT + uid + ":" + idGiaoDich, JSON.stringify(giaoDich));
  // Index riêng cho các giao dịch đang chờ — trang web admin đọc từ đây,
  // xóa ngay khi giao dịch được xử lý xong (xem xuLyXuLyRutTienAdmin).
  await env.USERS.put(TIEN_TO_CHO_DUYET_RUT + uid + ":" + idGiaoDich, "1");

  return Response.json({
    thanh_cong: true,
    coin_con_lai: nguoiDung.coin,
    ma_giao_dich: idGiaoDich,
    phi: soPhi,
    so_tien_thuc_nhan: soTien,
  });
}

// ==================================================
// 🖥️ WEB ADMIN — DUYỆT RÚT TIỀN (thay cơ chế nút bấm Telegram)
// Trang web tĩnh (public/admin-rut-tien.html) gọi 2 API dưới đây:
//   GET  /admin/rut-tien/danh-sach   → danh sách các yêu cầu đang chờ, mỗi
//                                      yêu cầu hiển thị thành 1 "tab" riêng
//   POST /admin/rut-tien/xu-ly       → Hoàn thành / Từ chối 1 yêu cầu;
//                                      xử lý xong thì tab đó biến mất khỏi
//                                      danh sách (vì bị xóa khỏi index chờ)
// Xác thực bằng secret cố định (ADMIN_WEB_SECRET, đặt qua Dashboard như
// các secret khác) gửi kèm ở header "X-Admin-Secret".
// ==================================================
function xacThucAdminWeb(env, request) {
  const secret = request.headers.get("X-Admin-Secret") || "";
  return Boolean(env.ADMIN_WEB_SECRET) && secret === env.ADMIN_WEB_SECRET;
}

async function xuLyDanhSachRutTienCho(env, request) {
  if (!xacThucAdminWeb(env, request)) {
    return Response.json({ loi: "khong_co_quyen" }, { status: 401 });
  }

  const danhSach = [];
  let cursor;
  for (;;) {
    const trang = await env.USERS.list({ prefix: TIEN_TO_CHO_DUYET_RUT, cursor });
    for (const key of trang.keys) {
      const phanConLai = key.name.slice(TIEN_TO_CHO_DUYET_RUT.length); // "{uid}:{id}"
      const viTri = phanConLai.indexOf(":");
      const uid = phanConLai.slice(0, viTri);
      const idGiaoDich = phanConLai.slice(viTri + 1);

      const raw = await env.USERS.get(TIEN_TO_GIAO_DICH_RUT + uid + ":" + idGiaoDich);
      if (!raw) continue; // index lệch dữ liệu gốc (hiếm) — bỏ qua
      const giaoDich = JSON.parse(raw);
      if (giaoDich.trangThai !== "cho_duyet") continue;

      const nguoiDung = await layNguoiDung(env, uid);
      danhSach.push({
        ...giaoDich,
        ten: nguoiDung ? nguoiDung.ten : "",
        username: nguoiDung ? nguoiDung.username : null,
      });
    }
    if (trang.list_complete) break;
    cursor = trang.cursor;
  }

  danhSach.sort((a, b) => a.taoLuc - b.taoLuc); // cũ nhất trước — xử lý theo thứ tự
  return Response.json({ danh_sach: danhSach });
}

async function xuLyXuLyRutTienAdmin(env, request) {
  if (!xacThucAdminWeb(env, request)) {
    return Response.json({ thanh_cong: false, loi: "khong_co_quyen" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ thanh_cong: false, loi: "body_khong_hop_le" }, { status: 400 });
  }

  const { uid, id: idGiaoDich, hanh_dong: hanhDong } = body || {};
  if (!uid || !idGiaoDich || !["hoan_thanh", "tu_choi"].includes(hanhDong)) {
    return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });
  }

  const key = TIEN_TO_GIAO_DICH_RUT + uid + ":" + idGiaoDich;
  const raw = await env.USERS.get(key);
  if (!raw) {
    return Response.json({ thanh_cong: false, loi: "khong_tim_thay" }, { status: 404 });
  }

  const giaoDich = JSON.parse(raw);
  if (giaoDich.trangThai !== "cho_duyet") {
    return Response.json({ thanh_cong: false, loi: "da_xu_ly_truoc_do" });
  }

  giaoDich.trangThai = hanhDong;
  giaoDich.duyetLuc = Date.now();
  giaoDich.duyetBoi = "web";
  await env.USERS.put(key, JSON.stringify(giaoDich));
  // Xử lý xong → xóa khỏi index chờ, tab tương ứng biến mất khỏi trang web.
  await env.USERS.delete(TIEN_TO_CHO_DUYET_RUT + uid + ":" + idGiaoDich);

  let textThongBaoUser;
  if (hanhDong === "tu_choi") {
    // Hoàn coin + trả lại hạn mức ngày/tuần đã trừ lúc gửi yêu cầu
    const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0 };
    nguoiDung.coin = (nguoiDung.coin || 0) + giaoDich.soCoin;
    await luuNguoiDung(env, uid, nguoiDung);

    if (giaoDich.keyNgay) {
      const daRutNgay = Number((await env.USERS.get(giaoDich.keyNgay)) || 0);
      await env.USERS.put(giaoDich.keyNgay, String(Math.max(0, daRutNgay - giaoDich.soCoin)));
    }
    if (giaoDich.keyTuan) {
      const daRutTuan = Number((await env.USERS.get(giaoDich.keyTuan)) || 0);
      await env.USERS.put(giaoDich.keyTuan, String(Math.max(0, daRutTuan - giaoDich.soCoin)));
    }
    if (giaoDich.keySoLanNgay) {
      const soLanDaRut = Number((await env.USERS.get(giaoDich.keySoLanNgay)) || 0);
      await env.USERS.put(giaoDich.keySoLanNgay, String(Math.max(0, soLanDaRut - 1)));
    }

    textThongBaoUser =
      `❌ Yêu cầu rút ${giaoDich.soCoin} coin (~${giaoDich.soTien.toLocaleString("vi-VN")}đ, mã ${idGiaoDich}) đã bị từ chối.\n` +
      `🪙 Số coin đã được hoàn lại vào tài khoản của bạn.`;
  } else {
    const ghiChuPhi = giaoDich.soPhi ? ` (đã trừ phí 10%: ${giaoDich.soPhi.toLocaleString("vi-VN")} coin)` : "";
    textThongBaoUser = `✅ Yêu cầu rút ${giaoDich.soCoin} coin${ghiChuPhi} (~${giaoDich.soTien.toLocaleString("vi-VN")}đ, mã ${idGiaoDich}) đã hoàn thành!`;
  }

  await telegramApi(env, "sendMessage", { chat_id: Number(uid), text: textThongBaoUser });

  return Response.json({ thanh_cong: true });
}

// ==================================================
// 🔁 DI CHUYỂN DỮ LIỆU KV → D1 — chạy 1 lần duy nhất lúc chuyển hạ tầng.
// Yêu cầu giữ tạm 2 binding KV cũ trong wrangler.toml với tên khác
// (USERS_KV_CU, ADMINS_KV_CU) trỏ vào đúng namespace KV đang dùng hiện tại
// — KHÔNG xóa 2 namespace đó cho tới khi xác nhận D1 đã đầy đủ dữ liệu.
// Gọi 1 lần: POST /admin/migrate-kv-to-d1 (cùng header X-Admin-Secret như
// các endpoint admin khác). Ghi đè (upsert) nên gọi lại nhiều lần vẫn an
// toàn, không tạo dữ liệu trùng.
// ==================================================
async function diChuyenNamespace(db, ns, kvCu) {
  let daChuyen = 0;
  let cursor;
  for (;;) {
    const trang = await kvCu.list({ cursor });
    for (const key of trang.keys) {
      const value = await kvCu.get(key.name);
      if (value !== null) {
        await d1Put(db, ns, key.name, value);
        daChuyen += 1;
      }
    }
    if (trang.list_complete) break;
    cursor = trang.cursor;
  }
  return daChuyen;
}

async function xuLyDiChuyenKvSangD1(env, request) {
  if (!xacThucAdminWeb(env, request)) {
    return Response.json({ thanh_cong: false, loi: "khong_co_quyen" }, { status: 401 });
  }
  if (!env.DB) {
    return Response.json({ thanh_cong: false, loi: "thieu_binding_d1_ten_DB" }, { status: 400 });
  }
  if (!env.USERS_KV_CU || !env.ADMINS_KV_CU) {
    return Response.json(
      { thanh_cong: false, loi: "thieu_binding_kv_cu_USERS_KV_CU_hoac_ADMINS_KV_CU" },
      { status: 400 }
    );
  }

  try {
    const daChuyenUsers = await diChuyenNamespace(env.DB, "users", env.USERS_KV_CU);
    const daChuyenAdmins = await diChuyenNamespace(env.DB, "admins", env.ADMINS_KV_CU);
    return Response.json({
      thanh_cong: true,
      da_chuyen_users: daChuyenUsers,
      da_chuyen_admins: daChuyenAdmins,
    });
  } catch (e) {
    return Response.json({ thanh_cong: false, loi: String(e) }, { status: 500 });
  }
}

// ==================================================
// 🚦 ENTRYPOINT — thay app.run() / bot.polling()
// ==================================================
export default {
  async fetch(requestGoc, envGoc, ctx) {
    const request = requestGoc;
    const env = boQuaD1(envGoc); // env.USERS / env.ADMINS giờ chạy trên D1 thay vì KV
    const url = new URL(request.url);

    // Migrate dữ liệu KV cũ → D1 — chỉ chạy khi cần, dùng binding KV cũ ở
    // envGoc (chưa bị boQuaD1 thay thế) làm nguồn đọc.
    if (request.method === "POST" && url.pathname === "/admin/migrate-kv-to-d1") {
      return xuLyDiChuyenKvSangD1({ ...env, USERS_KV_CU: envGoc.USERS_KV_CU, ADMINS_KV_CU: envGoc.ADMINS_KV_CU }, request);
    }

    // Webhook Telegram — xác thực bằng secret_token header, không dùng polling
    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      const chuKy = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (chuKy !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const update = await request.json();
      ctx.waitUntil(xuLyUpdate(env, update));
      return new Response("OK");
    }

    // Web admin duyệt rút tiền — POST, xác thực bằng header X-Admin-Secret
    if (request.method === "POST" && url.pathname === "/admin/rut-tien/xu-ly") {
      return xuLyXuLyRutTienAdmin(env, request);
    }

    // 🛠️ Chế độ bảo trì — nếu đang BẬT (bật/tắt qua lệnh Telegram /baotri,
    // xem xuLyBaoTri), chặn TOÀN BỘ request còn lại (cả trang miniapp lẫn
    // mọi API), CHỈ trừ trang quản lý rút tiền (để admin vẫn duyệt được)
    // và /suc-khoe (để hệ thống giám sát uptime không báo động nhầm).
    if (
      url.pathname !== "/admin/rut-tien/danh-sach" &&
      url.pathname !== "/suc-khoe" &&
      (await dangBaoTri(env))
    ) {
      return trangBaoTri();
    }

    if (request.method === "GET") {
      if (url.pathname.startsWith("/nv/")) {
        const ma = url.pathname.slice("/nv/".length);
        return xuLyTrangNhiemVu(env, ma);
      }

      switch (url.pathname) {
        case "/tao-nhiem-vu":
          return xuLyTaoNhiemVu(env, url, url.origin);
        case "/nhiem-vu-hien-tai":
          return xuLyNhiemVuHienTai(env, url);
        case "/reset-nhiem-vu":
          return xuLyResetNhiemVu(env, url);
        case "/xac-nhan-nhiem-vu":
          return xuLyXacNhanNhiemVu(env, url);
        case "/xac-nhan-quang-cao":
          return xuLyXacNhanQuangCao(env, url);
        case "/adsgram-callback":
          return xuLyAdsgramCallback(env, url);
        case "/thong-tin-diem-danh":
          return xuLyThongTinDiemDanh(env, url);
        case "/diem-danh":
          return xuLyDiemDanh(env, url);
        case "/nhap-gifcode":
          return xuLyNhapGifcode(env, url);
        case "/bat-dau-dao":
          return xuLyBatDauDao(env, url);
        case "/trang-thai-dao":
          return xuLyTrangThaiDao(env, url);
        case "/bang-xep-hang":
          return xuLyBangXepHang(env, url, ctx);
        case "/thong-tin-vi":
          return xuLyThongTinVi(env, url);
        case "/thong-tin-ban-be":
          return xuLyThongTinBanBe(env, url);
        case "/yeu-cau-rut-tien":
          return xuLyYeuCauRutTien(env, url);
        case "/admin/rut-tien/danh-sach":
          return xuLyDanhSachRutTienCho(env, request);
        case "/suc-khoe":
          return Response.json({ trang_thai: "on" });
      }
    }

    // Không khớp route API nào → phục vụ static assets (index.html của miniapp)
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger — 2 lịch chạy khai báo ở wrangler.toml ([triggers] crons):
  //   "0 */1 * * *" (mỗi giờ)   → làm mới cache bảng xếp hạng
  //   "0 14 * * *"  (14:00 UTC = 21:00 giờ VN mỗi ngày) → tự tạo gift code
  //                                300-500 coin, 50 lượt nhập
  // Phân biệt bằng event.cron để mỗi lịch chỉ chạy đúng việc của nó.
  async scheduled(event, envGoc, ctx) {
    const env = boQuaD1(envGoc);
    if (event.cron === "0 14 * * *") {
      ctx.waitUntil(taoGifcodeTuDong(env));
    } else {
      ctx.waitUntil(lamMoiCacheBangXepHang(env));
    }
  },
};
