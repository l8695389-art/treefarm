import { telegramApi, cho } from "./telegram.js";

const KEY_DANH_SACH_ADMIN = "danh_sach_admin";
const TIEN_TO_USER = "user:";
const TIEN_TO_QC_SO_LAN_NGAY = "qc-so-lan-ngay:";
const QC_GIOI_HAN_NGAY = 20;
const TIEN_TO_QC_LAN_CUOI = "qc-lan-cuoi:"; // mốc thời gian lần xem quảng cáo gần nhất — chặn spam
const QC_CHO_TOI_THIEU_MS = 30 * 1000; // phải chờ tối thiểu 30 giây giữa 2 lần xem quảng cáo
const TIEN_TO_TAI_KHOAN_NHAN = "tai-khoan-nhan:";
const TIEN_TO_BAN_BE = "ban-be:"; // ban-be:{uid_nguoi_moi} — JSON array các bạn đã mời qua link ref_
const COIN_DOI_GEM = 500000; // 500.000 coin đổi thủ công được 1 gem (nút "Đổi" ở tab Kho)
const SO_NGAY_DOI_TAI_KHOAN = 20; // chỉ cho đổi tài khoản nhận tiền 20 ngày / 1 lần
const TIEN_TO_GIAO_DICH_RUT = "giao-dich-rut:"; // giao-dich-rut:{uid}:{id} — lịch sử + trạng thái duyệt
const TIEN_TO_CHO_DUYET_RUT = "cho-duyet-rut:"; // cho-duyet-rut:{uid}:{id} — index riêng các giao dịch CHƯA xử lý, để web admin quét nhanh không phải duyệt toàn bộ lịch sử
const TIEN_TO_RUT_NGAY = "rut-gem-ngay:"; // đổi tiền tố so với bản cũ (rut-ngay: tính bằng đ) để không lẫn dữ liệu cũ khi chuyển sang tính bằng gem
const TIEN_TO_RUT_TUAN = "rut-gem-tuan:"; // tương tự, tránh lẫn với rut-tuan: (đơn vị đ) của bản cũ
const GEM_QUY_DOI_DONG = 500; // 1 gem = 500đ khi rút (chỉ dùng để tính số tiền chuyển khoản)
const RUT_TOI_THIEU = 40; // gem
const RUT_TOI_DA_NGAY = 60; // gem / ngày
const RUT_TOI_DA_TUAN = 200; // gem / tuần
const TIEN_TO_LINK4M_SO_LAN_NGAY = "link4m-so-lan-ngay:"; // số lần hoàn thành nhiệm vụ link4m hôm nay
const LINK4M_GIOI_HAN_NGAY = 2; // tăng từ 1 lên 2 lần/ngày
const KEY_CACHE_BANG_XEP_HANG = "cache-bang-xep-hang"; // JSON { kiem_xu, moi_ban, cap_nhat_luc } — làm mới mỗi 15 phút qua Cron Trigger
const KEY_MUA_GIAI = "mua-giai-bxh-hien-tai"; // JSON { bat_dau, ket_thuc } — mùa giải BXH hiện tại, tự mở mùa mới khi hết hạn
const MUA_GIAI_SO_NGAY = 7; // độ dài 1 mùa giải BXH (ngày)
const TOP_NHAN_THUONG = 10; // chỉ Top 10 mỗi bảng xếp hạng mới nhận thưởng khi kết thúc mùa giải (admin trao thủ công, giống quy trình duyệt rút tiền)
const PHAN_THUONG_KIEM_XU = [1000000, 600000, 400000, 200000, 200000, 100000, 100000, 100000, 100000, 100000]; // xu thưởng hạng 1→10, BXH "Đua Top Xu"
const PHAN_THUONG_MOI_BAN = [
  // xu + gem thưởng hạng 1→10, BXH "Đua Top Mời Bạn" — mỗi bậc có mốc số bạn tối thiểu (can) riêng;
  // đạt hạng nhưng chưa đủ mốc thì chỉ nhận 50% thưởng (xem tinhPhanThuong()).
  { xu: 500000, gem: 30, can: 10 },
  { xu: 300000, gem: 20, can: 5 },
  { xu: 200000, gem: 10, can: 5 },
  { xu: 50000, gem: 5, can: 2 },
  { xu: 50000, gem: 5, can: 2 },
  { xu: 50000, gem: 5, can: 2 },
  { xu: 50000, gem: 5, can: 2 },
  { xu: 50000, gem: 5, can: 2 },
  { xu: 50000, gem: 5, can: 2 },
  { xu: 50000, gem: 5, can: 2 },
];
const TIEN_TO_DIEM_DANH = "diem-danh:"; // diem-danh:{uid} — JSON { chuoi_hien_tai, ngay_cuoi }
const THUONG_DIEM_DANH = [3000, 5000, 8000, 12000, 16000, 22000, 30000]; // coin thưởng theo ngày 1→7 trong chu kỳ điểm danh, lặp lại sau ngày 7
const THUONG_COIN_MOI_MOI = 5000; // coin chào mừng cho người dùng mới — chỉ nhận 1 lần duy nhất khi /start lần đầu
const THUONG_MOI_BAN_THANH_CONG = 10000; // coin thưởng cho người mời khi mời được 1 bạn mới tham gia thành công
const TY_LE_HOA_HONG_GIOI_THIEU = [0.04, 0.02, 0.01]; // % hoa hồng nhiều tầng: cấp 1 (mời trực tiếp) 4%, cấp 2 2%, cấp 3 1% — trên số coin người được mời vừa kiếm được từ nhiệm vụ

// ==================================================
// 📋 QUẢN LÝ ADMIN — KV thay cho FILE_ADMIN (json)
// ==================================================
async function layDanhSachAdmin(env) {
  const raw = await env.ADMINS.get(KEY_DANH_SACH_ADMIN);
  if (raw) return JSON.parse(raw);
  const macDinh = [env.CHU_SO_HUU];
  await env.ADMINS.put(KEY_DANH_SACH_ADMIN, JSON.stringify(macDinh));
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
// sau khi xong (để gộp chung 1 lần ghi với các field khác). Việc quy đổi
// coin → gem giờ là thủ công, xem xuLyDoiCoinSangGem().
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

  const danhSachAdmin = await layDanhSachAdmin(env);
  await Promise.allSettled(
    danhSachAdmin.map((adminId) =>
      telegramApi(env, "sendMessage", { chat_id: Number(adminId), text: logText })
    )
  );

  await telegramApi(env, "sendMessage", { chat_id: env.NHOM_LOG, text: logText });
  if (!message.text) {
    await telegramApi(env, "forwardMessage", {
      chat_id: env.NHOM_LOG,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
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
      coin: THUONG_COIN_MOI_MOI, // 5.000 coin chào mừng — chỉ nhận 1 lần duy nhất
      gem: 0,
      tongDaKiem: THUONG_COIN_MOI_MOI, // thưởng chào mừng cũng tính vào bảng xếp hạng
      gioiThieuBoi: refUid,
    });
    await ghiLogVaThongBao(env, message, "| ✅ NGƯỜI DÙNG MỚI");
  } else {
    await ghiLogVaThongBao(env, message, "| Gọi lệnh /start");
  }

  if (laNguoiDungMoi && refUid) {
    await ghiNhanBanBeMoi(env, refUid, {
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
        [{ text: "📢 Kênh thông báo", url: "https://t.me/treefarm_news" }],
        [{ text: "🌐 Nhóm trò chuyện", url: "https://t.me/treefarm_chat" }],
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
  const gem = nguoiDung ? nguoiDung.gem || 0 : 0;

  const soLanQcDaXem = Number((await env.USERS.get(TIEN_TO_QC_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const qcLanCuoi = Number((await env.USERS.get(TIEN_TO_QC_LAN_CUOI + uid)) || 0);
  const soLanLink4mDaXong = Number((await env.USERS.get(TIEN_TO_LINK4M_SO_LAN_NGAY + uid + ":" + homNay)) || 0);

  const trangThaiChung = {
    coin,
    gem,
    so_lan_qc_da_xem: soLanQcDaXem,
    qc_gioi_han_ngay: QC_GIOI_HAN_NGAY,
    qc_lan_cuoi: qcLanCuoi,
    qc_cho_toi_thieu_giay: QC_CHO_TOI_THIEU_MS / 1000,
    so_lan_link4m_da_xong: soLanLink4mDaXong,
    link4m_gioi_han_ngay: LINK4M_GIOI_HAN_NGAY,
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

  const soCoinCong = Number(env.THUONG_COIN_QUANG_CAO || 5000);
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, gem: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    gem: nguoiDung.gem,
    so_lan_qc_da_xem: soLanMoi,
    qc_gioi_han_ngay: QC_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: QC_CHO_TOI_THIEU_MS / 1000,
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

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, gem: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    gem: nguoiDung.gem,
    coin_cong: soCoinCong,
    chuoi_hien_tai: chuoiMoi,
    thuong: THUONG_DIEM_DANH,
  });
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
  await xoaNhiemVuHienTai(env, uid); // dọn con trỏ, nhiệm vụ này xong rồi

  // Cộng thưởng coin
  const soCoinCong = Number(env.THUONG_COIN_NHIEM_VU || 25000);
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, gem: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);

  return Response.json({
    hoan_thanh: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    gem: nguoiDung.gem,
    so_lan_link4m_da_xong: soLanMoi,
    link4m_gioi_han_ngay: LINK4M_GIOI_HAN_NGAY,
  });
}

// ==================================================
// 🏆 BẢNG XẾP HẠNG — 2 chế độ:
//   • "kiem_xu"  Đua Top Xu       — xếp theo XU KIẾM ĐƯỢC TRONG MÙA GIẢI hiện tại
//   • "moi_ban"  Đua Top Mời Bạn  — xếp theo SỐ BẠN ĐÃ MỜI TRONG MÙA GIẢI hiện tại
// Chỉ Top 10 mỗi bảng mới nhận phần thưởng khi kết thúc mùa giải.
//
// Điểm số tính THEO MÙA (không phải lũy kế toàn thời gian): mỗi user lưu 1
// "mốc mùa giải" (mocMuaGiai) chụp lại tongDaKiem + số bạn bè tại thời điểm
// mùa hiện tại bắt đầu quét user đó lần đầu (lazy — chỉ ghi lại khi phát
// hiện số mùa đã đổi). Điểm hiển thị = giá trị lũy kế hiện tại − giá trị
// tại mốc. Nhờ vậy KHÔNG cần sửa mọi nơi cộng coin/bạn bè trong toàn bộ
// file, mùa mới tự "reset" điểm về 0 ngay lần quét đầu tiên của mùa đó.
//
// Để tránh quét toàn bộ KV (tốn CPU time) mỗi lần người dùng mở app, cả 2
// bảng được TÍNH TRƯỚC và lưu chung 1 cache, làm mới mỗi 15 phút bằng Cron
// Trigger (xem "scheduled" ở cuối file + [triggers] trong wrangler.toml).
// Endpoint /bang-xep-hang chỉ đọc cache; nếu chưa có cache (lần đầu deploy)
// thì tính trực tiếp 1 lần để không trả về rỗng.
// ==================================================
const MUC_TOI_THIEU_KIEM_XU = 50000; // xu tối thiểu kiếm được TRONG MÙA để được xếp vào BXH Đua Top Xu

// Đảm bảo user có mốc mùa giải khớp với mùa hiện tại — nếu chưa có hoặc
// mùa đã đổi thì chụp lại (coin, số bạn bè) hiện tại làm mốc 0 của mùa mới.
async function damBaoMocMuaGiai(env, uid, nguoiDung, soMuaHienTai) {
  const moc = nguoiDung.mocMuaGiai;
  if (moc && moc.so_mua === soMuaHienTai) return moc;

  const coinHienTai = nguoiDung.tongDaKiem != null ? nguoiDung.tongDaKiem : nguoiDung.coin || 0;
  const rawBanBe = await env.USERS.get(TIEN_TO_BAN_BE + uid);
  const banBeHienTai = rawBanBe ? JSON.parse(rawBanBe).length : 0;

  const mocMoi = { so_mua: soMuaHienTai, coin_goc: coinHienTai, ban_be_goc: banBeHienTai };
  nguoiDung.mocMuaGiai = mocMoi;
  await luuNguoiDung(env, uid, nguoiDung);
  return mocMoi;
}

async function tinhBangXepHangKiemXu(env, soMuaHienTai) {
  const QUET_TOI_DA = 500; // giới hạn số user quét mỗi lần gọi, tránh vượt CPU time free plan
  const ketQua = [];
  let daQuet = 0;

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

  ketQua.sort((a, b) => b.gia_tri - a.gia_tri);
  return ketQua.slice(0, 50);
}

async function tinhBangXepHangMoiBan(env, soMuaHienTai) {
  const QUET_TOI_DA = 500;
  const ketQua = [];
  let daQuet = 0;

  for await (const uid of duyetTatCaNguoiDung(env)) {
    if (daQuet >= QUET_TOI_DA) break;
    daQuet += 1;

    const nguoiDung = await layNguoiDung(env, uid);
    if (!nguoiDung) continue;

    const rawBanBe = await env.USERS.get(TIEN_TO_BAN_BE + uid);
    const banBeHienTai = rawBanBe ? JSON.parse(rawBanBe).length : 0;
    const moc = await damBaoMocMuaGiai(env, uid, nguoiDung, soMuaHienTai);
    const moiTrongMua = Math.max(0, banBeHienTai - moc.ban_be_goc);
    if (moiTrongMua <= 0) continue;

    const tenHienThi = (nguoiDung.ten && nguoiDung.ten.trim()) || (nguoiDung.username ? `@${nguoiDung.username}` : "");
    if (!tenHienThi) continue;

    ketQua.push({ uid, ten: tenHienThi, gia_tri: moiTrongMua });
  }

  ketQua.sort((a, b) => b.gia_tri - a.gia_tri);
  return ketQua.slice(0, 50);
}

// Tính lại + ghi cache — được gọi bởi Cron Trigger mỗi 15 phút.
async function lamMoiCacheBangXepHang(env, muaGiai) {
  const mg = muaGiai || (await layHoacTaoMuaGiai(env));
  const [kiemXu, moiBan] = await Promise.all([
    tinhBangXepHangKiemXu(env, mg.so),
    tinhBangXepHangMoiBan(env, mg.so),
  ]);
  const duLieu = { so_mua: mg.so, kiem_xu: kiemXu, moi_ban: moiBan, cap_nhat_luc: Date.now() };
  await env.USERS.put(KEY_CACHE_BANG_XEP_HANG, JSON.stringify(duLieu));
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
  if (raw) {
    const mg = JSON.parse(raw);
    if (mg.ket_thuc > bayGio) return mg;
    const moi = { so: (mg.so || 0) + 1, bat_dau: bayGio, ket_thuc: bayGio + MUA_GIAI_SO_NGAY * 24 * 60 * 60 * 1000 };
    await env.USERS.put(KEY_MUA_GIAI, JSON.stringify(moi));
    return moi;
  }
  const moi = { so: 1, bat_dau: bayGio, ket_thuc: bayGio + MUA_GIAI_SO_NGAY * 24 * 60 * 60 * 1000 };
  await env.USERS.put(KEY_MUA_GIAI, JSON.stringify(moi));
  return moi;
}

// Tính phần thưởng hiển thị cho 1 hạng — với BXH Mời Bạn, mỗi bậc thưởng có
// mốc số bạn tối thiểu riêng (vd hạng 1 cần ≥10 bạn); nếu đạt hạng nhưng
// chưa đủ mốc thì thưởng giảm 50%.
function tinhPhanThuong(loai, hang, giaTri) {
  if (hang > TOP_NHAN_THUONG) return { xu: 0, gem: 0, dieu_kien_toi_thieu: null, dat_dieu_kien: true };

  if (loai === "moi_ban") {
    const bac = PHAN_THUONG_MOI_BAN[hang - 1];
    const datDieuKien = giaTri >= bac.can;
    const heSo = datDieuKien ? 1 : 0.5;
    return {
      xu: Math.floor(bac.xu * heSo),
      gem: Math.floor(bac.gem * heSo),
      dieu_kien_toi_thieu: bac.can,
      dat_dieu_kien: datDieuKien,
    };
  }

  return { xu: PHAN_THUONG_KIEM_XU[hang - 1], gem: 0, dieu_kien_toi_thieu: null, dat_dieu_kien: true };
}

async function xuLyBangXepHang(env, url) {
  const loai = url.searchParams.get("loai") === "moi-ban" ? "moi_ban" : "kiem_xu";
  const uid = url.searchParams.get("uid");

  const muaGiai = await layHoacTaoMuaGiai(env);

  const raw = await env.USERS.get(KEY_CACHE_BANG_XEP_HANG);
  let cache = raw ? JSON.parse(raw) : null;
  // Cache thuộc mùa cũ (chưa kịp cron làm mới) — tính lại ngay để điểm không bị lẫn mùa.
  if (!cache || cache.so_mua !== muaGiai.so) {
    cache = await lamMoiCacheBangXepHang(env, muaGiai);
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
      const nd = await layNguoiDung(env, uid);
      if (nd) {
        const moc = await damBaoMocMuaGiai(env, uid, nd, muaGiai.so);
        if (loai === "kiem_xu") {
          const coinHienTai = nd.tongDaKiem != null ? nd.tongDaKiem : nd.coin || 0;
          giaTriCuaToi = Math.max(0, coinHienTai - moc.coin_goc);
        } else {
          const rawBanBe = await env.USERS.get(TIEN_TO_BAN_BE + uid);
          const banBeHienTai = rawBanBe ? JSON.parse(rawBanBe).length : 0;
          giaTriCuaToi = Math.max(0, banBeHienTai - moc.ban_be_goc);
        }
      }
    }
  }

  return Response.json({
    mua_giai: muaGiai,
    loai,
    don_vi_gia_tri: loai === "moi_ban" ? "luot_moi" : "xu",
    muc_toi_thieu_bxh: loai === "kiem_xu" ? MUC_TOI_THIEU_KIEM_XU : null,
    top_nhan_thuong: TOP_NHAN_THUONG,
    bang_thuong: Array.from({ length: TOP_NHAN_THUONG }, (_, i) =>
      loai === "moi_ban"
        ? { hang: i + 1, xu: PHAN_THUONG_MOI_BAN[i].xu, gem: PHAN_THUONG_MOI_BAN[i].gem, dieu_kien_toi_thieu: PHAN_THUONG_MOI_BAN[i].can }
        : { hang: i + 1, xu: PHAN_THUONG_KIEM_XU[i], gem: 0, dieu_kien_toi_thieu: null }
    ),
    bang_xep_hang: danhSach.map((nd, idx) => ({
      hang: idx + 1,
      uid: nd.uid,
      ten: nd.ten,
      gia_tri: nd.gia_tri,
      phan_thuong: tinhPhanThuong(loai, idx + 1, nd.gia_tri),
    })),
    hang_cua_toi: hangCuaToi,
    gia_tri_cua_toi: giaTriCuaToi,
    cap_nhat_luc: cache.cap_nhat_luc,
  });
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

// +10.000 coin cho người mời khi mời được 1 người bạn mới tham gia thành công
// (chỉ tính 1 lần/người được mời, do chỉ gọi khi laNguoiDungMoi === true)
async function congThuongMoiBanThanhCong(env, refUid) {
  const nguoiGioiThieu = await layNguoiDung(env, refUid);
  if (!nguoiGioiThieu) return;
  nguoiGioiThieu.coin = (nguoiGioiThieu.coin || 0) + THUONG_MOI_BAN_THANH_CONG;
  nguoiGioiThieu.tongDaKiem = (nguoiGioiThieu.tongDaKiem || 0) + THUONG_MOI_BAN_THANH_CONG;
  await luuNguoiDung(env, refUid, nguoiGioiThieu);
}

async function xuLyThongTinBanBe(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const raw = await env.USERS.get(TIEN_TO_BAN_BE + uid);
  const danhSach = raw ? JSON.parse(raw) : [];

  return Response.json({
    so_luong: danhSach.length,
    danh_sach: danhSach.map((nb) => ({ ten: nb.ten, tham_gia_luc: nb.thamGiaLuc })),
  });
}

// Đổi coin → gem thủ công (nút "Đổi" ở tab Kho) — số coin nhập phải là bội
// số dương của COIN_DOI_GEM (500.000). Không tự động đổi ở bất kỳ đâu khác.
async function xuLyDoiCoinSangGem(env, url) {
  const uid = url.searchParams.get("uid");
  const soCoin = Number(url.searchParams.get("so_coin"));

  if (!uid || !soCoin) {
    return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });
  }
  if (!Number.isFinite(soCoin) || !Number.isInteger(soCoin) || soCoin <= 0 || soCoin % COIN_DOI_GEM !== 0) {
    return Response.json({ thanh_cong: false, loi: "so_coin_khong_hop_le", coin_doi_gem: COIN_DOI_GEM });
  }

  const nguoiDung = await layNguoiDung(env, uid);
  const coinHienCo = nguoiDung ? nguoiDung.coin || 0 : 0;
  if (soCoin > coinHienCo) {
    return Response.json({ thanh_cong: false, loi: "khong_du_coin" });
  }

  const soGemMoi = soCoin / COIN_DOI_GEM;
  nguoiDung.coin = coinHienCo - soCoin;
  nguoiDung.gem = (nguoiDung.gem || 0) + soGemMoi;
  await luuNguoiDung(env, uid, nguoiDung);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    gem: nguoiDung.gem,
    so_gem_nhan: soGemMoi,
  });
}

async function xuLyThongTinVi(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = await layNguoiDung(env, uid);
  const coin = nguoiDung ? nguoiDung.coin || 0 : 0;
  const gem = nguoiDung ? nguoiDung.gem || 0 : 0;

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

  const lichSu = await layLichSuRutTien(env, uid);

  return Response.json({
    coin: coin,
    gem: gem,
    gem_quy_doi_dong: GEM_QUY_DOI_DONG,
    rut_toi_thieu: RUT_TOI_THIEU,
    tai_khoan: taiKhoan,
    co_the_doi_tai_khoan: coTheDoiTaiKhoan,
    so_ngay_con_lai_de_doi: soNgayConLaiDeDoi,
    con_lai_ngay: Math.max(0, RUT_TOI_DA_NGAY - daRutNgay),
    con_lai_tuan: Math.max(0, RUT_TOI_DA_TUAN - daRutTuan),
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
  const soGem = Number(url.searchParams.get("so_gem"));

  if (!uid || !nganHang || !soTk || !tenNguoiNhan || !soGem) {
    return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });
  }
  if (!Number.isFinite(soGem) || !Number.isInteger(soGem) || soGem < RUT_TOI_THIEU) {
    return Response.json({ thanh_cong: false, loi: "duoi_toi_thieu" });
  }

  const nguoiDung = await layNguoiDung(env, uid);
  const gemHienCo = nguoiDung ? nguoiDung.gem || 0 : 0;
  if (soGem > gemHienCo) {
    return Response.json({ thanh_cong: false, loi: "khong_du_gem" });
  }

  const soTien = soGem * GEM_QUY_DOI_DONG; // số tiền quy đổi để admin chuyển khoản

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
  const daRutNgay = Number((await env.USERS.get(keyNgay)) || 0);
  const daRutTuan = Number((await env.USERS.get(keyTuan)) || 0);

  if (daRutNgay + soGem > RUT_TOI_DA_NGAY) {
    return Response.json({ thanh_cong: false, loi: "vuot_han_muc_ngay" });
  }
  if (daRutTuan + soGem > RUT_TOI_DA_TUAN) {
    return Response.json({ thanh_cong: false, loi: "vuot_han_muc_tuan" });
  }

  // Trừ gem ngay — coi như gem bị giữ lại chờ admin xử lý thủ công,
  // tránh gửi trùng nhiều yêu cầu vượt quá số gem thực có.
  nguoiDung.gem = gemHienCo - soGem;
  await luuNguoiDung(env, uid, nguoiDung);

  if (!taiKhoanDaLuu || laDoiTaiKhoan) {
    await env.USERS.put(
      TIEN_TO_TAI_KHOAN_NHAN + uid,
      JSON.stringify({ nganHang, soTk, tenNguoiNhan, capNhatLuc: Date.now() })
    );
  }
  await env.USERS.put(keyNgay, String(daRutNgay + soGem));
  await env.USERS.put(keyTuan, String(daRutTuan + soGem));

  // Tạo bản ghi giao dịch — trạng thái "cho_duyet" cho tới khi admin xử lý
  // trên trang web quản lý rút tiền. Từ chối thì hoàn tiền cho user.
  const idGiaoDich = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const giaoDich = {
    id: idGiaoDich,
    uid: String(uid),
    nganHang,
    soTk,
    tenNguoiNhan,
    soGem,
    soTien, // số tiền quy đổi (soGem * GEM_QUY_DOI_DONG) — để admin chuyển khoản
    trangThai: "cho_duyet",
    taoLuc: Date.now(),
    keyNgay,
    keyTuan,
  };
  await env.USERS.put(TIEN_TO_GIAO_DICH_RUT + uid + ":" + idGiaoDich, JSON.stringify(giaoDich));
  // Index riêng cho các giao dịch đang chờ — trang web admin đọc từ đây,
  // xóa ngay khi giao dịch được xử lý xong (xem xuLyXuLyRutTienAdmin).
  await env.USERS.put(TIEN_TO_CHO_DUYET_RUT + uid + ":" + idGiaoDich, "1");

  return Response.json({ thanh_cong: true, gem_con_lai: nguoiDung.gem, ma_giao_dich: idGiaoDich });
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
    // Hoàn gem + trả lại hạn mức ngày/tuần đã trừ lúc gửi yêu cầu
    const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, gem: 0 };
    nguoiDung.gem = (nguoiDung.gem || 0) + giaoDich.soGem;
    await luuNguoiDung(env, uid, nguoiDung);

    if (giaoDich.keyNgay) {
      const daRutNgay = Number((await env.USERS.get(giaoDich.keyNgay)) || 0);
      await env.USERS.put(giaoDich.keyNgay, String(Math.max(0, daRutNgay - giaoDich.soGem)));
    }
    if (giaoDich.keyTuan) {
      const daRutTuan = Number((await env.USERS.get(giaoDich.keyTuan)) || 0);
      await env.USERS.put(giaoDich.keyTuan, String(Math.max(0, daRutTuan - giaoDich.soGem)));
    }

    textThongBaoUser =
      `❌ Yêu cầu rút ${giaoDich.soGem} gem (~${giaoDich.soTien.toLocaleString("vi-VN")}đ, mã ${idGiaoDich}) đã bị từ chối.\n` +
      `💎 Số gem đã được hoàn lại vào tài khoản của bạn.`;
  } else {
    textThongBaoUser = `✅ Yêu cầu rút ${giaoDich.soGem} gem (~${giaoDich.soTien.toLocaleString("vi-VN")}đ, mã ${idGiaoDich}) đã hoàn thành!`;
  }

  await telegramApi(env, "sendMessage", { chat_id: Number(uid), text: textThongBaoUser });

  return Response.json({ thanh_cong: true });
}

// ==================================================
// 🚦 ENTRYPOINT — thay app.run() / bot.polling()
// ==================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
        case "/thong-tin-diem-danh":
          return xuLyThongTinDiemDanh(env, url);
        case "/diem-danh":
          return xuLyDiemDanh(env, url);
        case "/bang-xep-hang":
          return xuLyBangXepHang(env, url);
        case "/thong-tin-vi":
          return xuLyThongTinVi(env, url);
        case "/doi-coin-gem":
          return xuLyDoiCoinSangGem(env, url);
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

  // Cron Trigger — làm mới cache bảng xếp hạng mỗi 15 phút (xem wrangler.toml: [triggers] crons)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(lamMoiCacheBangXepHang(env));
  },
};
