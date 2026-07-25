import { telegramApi, cho } from "./telegram.js";

const KEY_DANH_SACH_ADMIN = "danh_sach_admin";
const TIEN_TO_USER = "user:";

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

  if (!nguoiDungCu) {
    await luuNguoiDung(env, uid, {
      ten: `${message.from.first_name} ${message.from.last_name || ""}`.trim(),
      username: message.from.username || null,
      ngay_tham_gia: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      coin: 0,
      gem: 0,
      soDu: 0,
    });
    await ghiLogVaThongBao(env, message, "| ✅ NGƯỜI DÙNG MỚI");
  } else {
    await ghiLogVaThongBao(env, message, "| Gọi lệnh /start");
  }

  return telegramApi(env, "sendPhoto", {
    chat_id: message.chat.id,
    photo: env.LINK_ANH,
    caption:
      "👋 Chào bạn! Chào mừng đến với Tree Farm 🌾\n\n" +
      "Trồng trọt, làm nhiệm vụ mỗi ngày và tích xu đổi thưởng.\n" +
      "Mời bạn bè, leo bảng xếp hạng và rút kim cương khi đủ điều kiện.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🌾 MỞ TRANG TRẠI NGAY", web_app: { url: env.LINK_MINIAPP } }],
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
const TIEN_TO_NGAY_HOAN_THANH = "ngay_hoan_thanh:";
const TIEN_TO_NHIEM_VU_HIEN_TAI = "nhiemvu-hientai:"; // con trỏ nhiệm vụ đang chờ, để khôi phục khi mở lại app
const TTL_NHIEM_VU_MS = 30 * 60 * 1000; // 30 phút

function ngayVnHomNay() {
  // định dạng YYYY-MM-DD theo giờ Việt Nam, reset đúng 00:00 giờ VN
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
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

  // Chặn sớm nếu hôm nay đã hoàn thành rồi — đỡ tốn 1 lượt gọi Link4M vô ích
  const ngayDaHoanThanh = await env.USERS.get(TIEN_TO_NGAY_HOAN_THANH + uid);
  if (ngayDaHoanThanh === homNay) {
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
// biết đã hoàn thành hôm nay chưa, và hiện số dư.
async function xuLyNhiemVuHienTai(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const nguoiDung = await layNguoiDung(env, uid);
  const soDu = nguoiDung ? nguoiDung.soDu || 0 : 0;

  const ngayDaHoanThanh = await env.USERS.get(TIEN_TO_NGAY_HOAN_THANH + uid);
  if (ngayDaHoanThanh === homNay) {
    return Response.json({ trang_thai: "da_hoan_thanh", so_du: soDu });
  }

  const dangCho = await layNhiemVuHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ trang_thai: "dang_cho", link: dangCho.link, so_du: soDu });
  }

  return Response.json({ trang_thai: "chua_co", so_du: soDu });
}

// Reset mã — hủy nhiệm vụ đang chờ (CHƯA hoàn thành) để tạo lại link mới,
// dùng khi lỡ mất mã/đóng nhầm trang đích. Không cho reset nếu đã xong
// hôm nay rồi, tránh lách giới hạn ngày.
async function xuLyResetNhiemVu(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const ngayDaHoanThanh = await env.USERS.get(TIEN_TO_NGAY_HOAN_THANH + uid);
  if (ngayDaHoanThanh === homNay) {
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
  const ngayDaHoanThanh = await env.USERS.get(TIEN_TO_NGAY_HOAN_THANH + uid);
  if (ngayDaHoanThanh === homNay) {
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
  await env.USERS.put(TIEN_TO_NGAY_HOAN_THANH + uid, homNay);
  await xoaNhiemVuHienTai(env, uid); // dọn con trỏ, nhiệm vụ này xong rồi

  // Cộng thưởng vào số dư
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, gem: 0, soDu: 0 };
  nguoiDung.soDu = (nguoiDung.soDu || 0) + Number(env.THUONG_SO_DU_NHIEM_VU || 300);
  await luuNguoiDung(env, uid, nguoiDung);

  return Response.json({ hoan_thanh: true, so_du: nguoiDung.soDu });
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
        case "/suc-khoe":
          return Response.json({ trang_thai: "on" });
      }
    }

    // Không khớp route API nào → phục vụ static assets (index.html của miniapp)
    return env.ASSETS.fetch(request);
  },
};
