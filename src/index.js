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

// TRƯỚC ĐÂY dùng "key LIKE ?2 ESCAPE '\\'" để lọc theo prefix — nhưng theo
// tài liệu chính thức của SQLite (Query Optimizer Overview), ĐIỀU KIỆN BẮT
// BUỘC để LIKE tận dụng được index là "mệnh đề ESCAPE KHÔNG được xuất hiện".
// Có ESCAPE nghĩa là SQLite BỎ QUA tối ưu index, quét TOÀN BỘ các dòng
// khớp ns=?1 (tức là toàn bộ dữ liệu app, không riêng gì prefix cần tìm)
// rồi mới lọc LIKE trong bộ nhớ — khiến rows_read của D1 tăng vọt theo
// TỔNG số dòng toàn hệ thống thay vì theo số dòng thực sự khớp prefix.
// Đây chính là nguyên nhân khiến D1 báo đọc hơn 1 triệu dòng/ngày dù app
// chỉ có ~170 user. Sửa lại bằng range query "key >= prefix AND key <
// capTrên" — dùng đúng kỹ thuật range-scan trên B-tree index, không phụ
// thuộc bất kỳ điều kiện tối ưu tinh vi nào của LIKE.
//
// Tính cận trên (EXCLUSIVE) cho 1 prefix theo thứ tự byte: tăng ký tự cuối
// cùng của prefix lên 1 đơn vị. Mọi key bắt đầu bằng prefix chắc chắn nhỏ
// hơn cận trên này (vì tại vị trí ký tự cuối, prefix có mã nhỏ hơn 1 đơn
// vị so với cận trên, bất kể các ký tự theo sau là gì).
function capTrenChoPrefix(prefix) {
  if (!prefix) return null; // prefix rỗng = không giới hạn trên
  const maKyTuCuoi = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(maKyTuCuoi + 1);
}

async function d1Get(db, ns, key) {
  const hang = await db.prepare("SELECT value FROM kv WHERE ns = ?1 AND key = ?2").bind(ns, key).first();
  return hang ? hang.value : null;
}

// Trả về statement ĐÃ bind nhưng CHƯA chạy — dùng khi cần gộp nhiều lệnh ghi
// vào 1 lượt db.batch() duy nhất (vd cập nhật mốc mùa giải cho hàng loạt
// user khi tính lại bảng xếp hạng), thay vì mỗi lệnh 1 round-trip riêng.
function d1PutCauLenh(db, ns, key, value) {
  return db
    .prepare(
      "INSERT INTO kv (ns, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value"
    )
    .bind(ns, key, String(value));
}

async function d1Put(db, ns, key, value) {
  await d1PutCauLenh(db, ns, key, value).run();
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
  const capTren = capTrenChoPrefix(prefix);

  const thamSo = [ns, prefix];
  let cauLenh = "SELECT key FROM kv WHERE ns = ?1 AND key >= ?2";
  let idx = 3;
  if (capTren !== null) {
    cauLenh += ` AND key < ?${idx}`;
    thamSo.push(capTren);
    idx += 1;
  }
  if (cursor) {
    cauLenh += ` AND key > ?${idx}`;
    thamSo.push(cursor);
    idx += 1;
  }
  cauLenh += ` ORDER BY key ASC LIMIT ?${idx}`;
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

// ==================================================
// 🔐 XÁC THỰC TELEGRAM INIT DATA — mọi endpoint đọc/ghi dữ liệu theo uid
// TRƯỚC ĐÂY lấy thẳng uid từ query string do CLIENT tự khai (dễ giả mạo —
// ai cũng gõ được 1 uid bất kỳ vào URL để đọc/ghi dữ liệu của người khác,
// kể cả đổi tài khoản nhận tiền rút). Giờ bắt buộc xác thực initData THẬT
// do Telegram ký (HMAC-SHA256 dựa trên bot token, theo đúng thuật toán
// chính thức của Telegram WebApp), không tin uid client gửi lên nữa.
// ==================================================
const TTL_INIT_DATA_GIAY = 86400; // 24h — initData cũ hơn mức này bị từ chối (chống replay)

async function hmacSha256(khoaRawBytes, duLieuChuoi) {
  const khoa = await crypto.subtle.importKey("raw", khoaRawBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", khoa, new TextEncoder().encode(duLieuChuoi));
}

function hexHoa(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// So sánh CỐ ĐỊNH thời gian — tránh lộ thông tin qua timing attack, dùng
// cho cả so khớp hash initData lẫn ADMIN_WEB_SECRET.
function soSanhAnToan(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let khac = 0;
  for (let i = 0; i < a.length; i++) khac |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return khac === 0;
}

// Xác thực chuỗi initData Telegram gửi lên (header X-Telegram-Init-Data) —
// trả về { uid, user } nếu hợp lệ, null nếu chữ ký sai / hết hạn / thiếu
// dữ liệu user. Xem thuật toán chính thức: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function xacThucInitData(botToken, initDataTho) {
  if (!botToken || !initDataTho) return null;

  const params = new URLSearchParams(initDataTho);
  const hashNhanDuoc = params.get("hash");
  if (!hashNhanDuoc) return null;
  params.delete("hash");

  const cacCap = [];
  for (const [key, value] of params.entries()) cacCap.push(`${key}=${value}`);
  cacCap.sort();
  const dataCheckString = cacCap.join("\n");

  const secretKeyBuffer = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const hashBuffer = await hmacSha256(new Uint8Array(secretKeyBuffer), dataCheckString);
  if (!soSanhAnToan(hexHoa(hashBuffer), hashNhanDuoc)) return null; // chữ ký sai — initData giả mạo hoặc sai bot token

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > TTL_INIT_DATA_GIAY) return null; // hết hạn / chống replay tấn công

  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw);
    if (!user || !user.id) return null;
    return { uid: String(user.id), user };
  } catch (e) {
    return null;
  }
}

// Danh sách đường dẫn GET bắt buộc phải kèm initData hợp lệ — gồm mọi
// endpoint đọc/ghi dữ liệu cá nhân của user (coin, ví, đào, nhiệm vụ, BXH,
// bạn bè, rút tiền...). KHÔNG gồm: /webhook (đã có secret_token riêng),
// /admin/* (đã có ADMIN_WEB_SECRET), /adsgram-callback (webhook S2S từ
// Adsgram, không chạy trong Telegram WebView nên không có initData),
// /nv/<ma>, /nvtp/<ma>, /nvbb/<ma> và /nvlm/<ma> (trang đích mở ngoài
// Telegram, không lộ dữ liệu của ai khác), /suc-khoe (health check).
const DUONG_DAN_CAN_XAC_THUC_INIT_DATA = new Set([
  "/kiem-tra-thanh-vien",
  "/tao-nhiem-vu",
  "/nhiem-vu-hien-tai",
  "/reset-nhiem-vu",
  "/xac-nhan-nhiem-vu",
  "/tao-nhiem-vu-tp",
  "/nhiem-vu-hien-tai-tp",
  "/reset-nhiem-vu-tp",
  "/xac-nhan-nhiem-vu-tp",
  "/tao-nhiem-vu-bb",
  "/nhiem-vu-hien-tai-bb",
  "/reset-nhiem-vu-bb",
  "/xac-nhan-nhiem-vu-bb",
  "/tao-nhiem-vu-lm",
  "/nhiem-vu-hien-tai-lm",
  "/reset-nhiem-vu-lm",
  "/xac-nhan-nhiem-vu-lm",
  "/xac-nhan-quang-cao",
  "/thong-tin-diem-danh",
  "/diem-danh",
  "/nhap-gifcode",
  "/bat-dau-dao",
  "/trang-thai-dao",
  "/shop-thong-tin",
  "/shop-mua",
  "/lam-them-thong-tin",
  "/quay-thuong",
  "/bang-xep-hang",
  "/thong-tin-vi",
  "/thong-tin-ban-be",
  "/yeu-cau-rut-tien",
]);

// ==================================================
// 🔒 BẮT BUỘC THAM GIA NHÓM + KÊNH — trước khi cho vào miniapp, frontend
// gọi /kiem-tra-thanh-vien để hỏi bot xem user (theo Telegram ID) đã tham
// gia NHÓM TRÒ CHUYỆN và KÊNH THÔNG BÁO chưa (dùng Bot API getChatMember).
// Chưa đủ 2 điều kiện → app hiện màn hình "Tham gia để mở khóa", đã đủ →
// vào thẳng app như bình thường. Link mặc định dùng khi chưa cấu hình biến
// môi trường LINK_NHOM_CHAT / LINK_KENH_THONG_BAO trên Worker.
// ==================================================
const LINK_NHOM_MAC_DINH = "https://t.me/vuacaytien_chat";
const LINK_KENH_MAC_DINH = "https://t.me/vuacaytien_news";
// Các trạng thái getChatMember được coi là "đã tham gia" — "left"/"kicked"
// (hoặc bất kỳ trạng thái lạ nào khác) đều bị coi là CHƯA tham gia.
const TRANG_THAI_DA_THAM_GIA = ["creator", "administrator", "member", "restricted"];

// Kiểm tra 1 user có đang là thành viên của 1 chat (nhóm hoặc kênh) hay
// không, qua Bot API getChatMember — yêu cầu bot phải có mặt trong chat đó
// (khuyến khích thêm bot làm admin để đọc được cả kênh).
async function laThanhVienChat(env, chatId, uid) {
  if (!chatId) return true; // chưa cấu hình chat này trên Worker — bỏ qua điều kiện, không chặn nhầm user
  try {
    const ketQua = await telegramApi(env, "getChatMember", { chat_id: chatId, user_id: Number(uid) });
    if (!ketQua || !ketQua.ok) return false;
    const trangThai = ketQua.result && ketQua.result.status;
    return TRANG_THAI_DA_THAM_GIA.includes(trangThai);
  } catch (e) {
    // Lỗi mạng/API tạm thời (vd Telegram chậm) — KHÔNG chặn oan user, coi
    // như đã tham gia; lần kiểm tra kế tiếp (khi mở lại app) sẽ tự đúng lại.
    return true;
  }
}

// /kiem-tra-thanh-vien?uid=... — frontend gọi ngay sau màn hình tải để
// quyết định cho vào thẳng app hay chặn lại ở màn hình "Tham gia để mở khóa".
// Kiểm tra 2 chat: env.NHOM_CHAT (nhóm trò chuyện, đã dùng sẵn để gửi thông
// báo gift code) và env.KENH_CHAT (kênh thông báo, cần thêm binding riêng
// vì trước giờ code không gửi tin vào kênh nên chưa cần biết chat_id của
// nó). Nếu 1 trong 2 biến môi trường trên chưa cấu hình, điều kiện đó được
// bỏ qua (coi như luôn đạt) để không khóa nhầm khi admin chưa setup đủ.
async function xuLyKiemTraThanhVien(env, url) {
  const uid = url.searchParams.get("uid");
  const linkNhom = env.LINK_NHOM_CHAT || LINK_NHOM_MAC_DINH;
  const linkKenh = env.LINK_KENH_THONG_BAO || LINK_KENH_MAC_DINH;

  if (!uid) {
    // Thiếu uid (vd mở ngoài Telegram) — không thể kiểm tra, mặc định cho
    // qua để không khóa cứng người dùng trong trường hợp bất thường này.
    return Response.json({ thanh_cong: false, loi: "thieu_uid", da_tham_gia: true, link_nhom: linkNhom, link_kenh: linkKenh });
  }

  const [trongNhom, trongKenh] = await Promise.all([
    laThanhVienChat(env, env.NHOM_CHAT, uid),
    laThanhVienChat(env, env.KENH_CHAT, uid),
  ]);

  const thieu = [];
  if (!trongNhom) thieu.push("nhom");
  if (!trongKenh) thieu.push("kenh");

  return Response.json({
    thanh_cong: true,
    da_tham_gia: thieu.length === 0,
    thieu, // ["nhom"] và/hoặc ["kenh"] — frontend có thể dùng để tô đậm phần còn thiếu (hiện tại hiện chung 1 màn hình cho cả 2)
    link_nhom: linkNhom,
    link_kenh: linkKenh,
  });
}
// Bộ đếm TOÀN CỤC (cộng dồn all-time, gộp mọi user) — dùng cho lệnh admin
// /checknv để xem nhanh tổng số lượt nhiệm vụ đã hoàn thành, không cần quét
// lại toàn bộ user mỗi lần hỏi. Lưu ở namespace ADMINS (giống KEY_BAO_TRI,
// KEY_DANH_SACH_ADMIN — đều là cấu hình/thống kê toàn hệ thống, không phải
// dữ liệu riêng của 1 user).
const KEY_TONG_LUOT_QC = "tong-luot-qc-hoan-thanh"; // tổng lượt xem quảng cáo Monetag đã hoàn thành (mọi user, mọi thời điểm)
const KEY_TONG_LUOT_ADSGRAM = "tong-luot-adsgram-hoan-thanh"; // tương tự, cho quảng cáo Adsgram
const KEY_TONG_LUOT_LINK4M = "tong-luot-link4m-hoan-thanh"; // tương tự, cho lượt vượt link Link4M hoàn thành
const KEY_TONG_LUOT_TAPLAYMA = "tong-luot-taplayma-hoan-thanh"; // tương tự, cho lượt vượt link Taplayma hoàn thành
const KEY_TONG_LUOT_BBMKTS = "tong-luot-bbmkts-hoan-thanh"; // tương tự, cho lượt vượt link bbmkts hoàn thành
const KEY_TONG_LUOT_LAYMA = "tong-luot-layma-hoan-thanh"; // tương tự, cho lượt vượt link Layma.net hoàn thành

// Bộ đếm THEO TỪNG NGÀY (khác bộ đếm all-time ở trên) — dùng để /checknv
// hiển thị 7 ngày gần nhất thay vì 1 con số tổng cộng dồn từ trước tới nay.
// Key = tiền tố + "YYYY-MM-DD" (giờ VN), lưu ở namespace ADMINS giống các
// bộ đếm toàn cục khác trong file này.
const TIEN_TO_QC_NGAY_TK = "tong-luot-qc-ngay:";
const TIEN_TO_ADSGRAM_NGAY_TK = "tong-luot-adsgram-ngay:";
const TIEN_TO_LINK4M_NGAY_TK = "tong-luot-link4m-ngay:";
const TIEN_TO_TAPLAYMA_NGAY_TK = "tong-luot-taplayma-ngay:";
const TIEN_TO_BBMKTS_NGAY_TK = "tong-luot-bbmkts-ngay:";
const TIEN_TO_LAYMA_NGAY_TK = "tong-luot-layma-ngay:";
const SO_NGAY_THONG_KE_NHIEM_VU = 7; // /checknv hiển thị tối đa 7 ngày gần nhất
const TIEN_TO_USER = "user:";
const TIEN_TO_QC_SO_LAN_NGAY = "qc-so-lan-ngay:";
const QC_GIOI_HAN_NGAY = 10;
const TIEN_TO_QC_LAN_CUOI = "qc-lan-cuoi:"; // mốc thời gian lần xem quảng cáo gần nhất — chặn spam
const QC_CHO_TOI_THIEU_MS = 15 * 60 * 1000; // phải chờ tối thiểu 15 phút giữa 2 lần xem quảng cáo
const TIEN_TO_ADSGRAM_SO_LAN_NGAY = "adsgram-so-lan-ngay:"; // số lần được cộng thưởng Adsgram hôm nay
const ADSGRAM_GIOI_HAN_NGAY = 10;
const TIEN_TO_ADSGRAM_LAN_CUOI = "adsgram-lan-cuoi:"; // mốc thời gian lần cộng thưởng Adsgram gần nhất — chặn callback dồn dập
const ADSGRAM_CHO_TOI_THIEU_MS = 15 * 60 * 1000; // phải chờ tối thiểu 15 phút giữa 2 lần được cộng thưởng Adsgram
const TIEN_TO_TAI_KHOAN_NHAN = "tai-khoan-nhan:";
const TIEN_TO_BAN_BE = "ban-be:"; // ban-be:{uid_nguoi_moi} — JSON array các bạn đã mời qua link ref_
const TIEN_TO_LICH_SU_QUAY = "lich-su-quay:"; // lich-su-quay:{uid} — JSON array các lượt quay vòng quay may mắn gần nhất
const SO_LUOT_LICH_SU_QUAY_LUU = 15; // chỉ giữ 15 lượt gần nhất/user, mới nhất lên đầu
const SO_NGAY_DOI_TAI_KHOAN = 20; // chỉ cho đổi tài khoản nhận tiền 20 ngày / 1 lần
const TIEN_TO_GIAO_DICH_RUT = "giao-dich-rut:"; // giao-dich-rut:{uid}:{id} — lịch sử + trạng thái duyệt
const TIEN_TO_CHO_DUYET_RUT = "cho-duyet-rut:"; // cho-duyet-rut:{uid}:{id} — index riêng các giao dịch CHƯA xử lý, để web admin quét nhanh không phải duyệt toàn bộ lịch sử
const TIEN_TO_RUT_NGAY = "rut-gem-ngay:"; // giữ tiền tố cũ để không lẫn dữ liệu hạn mức trước khi gộp gem vào coin
const TIEN_TO_RUT_TUAN = "rut-gem-tuan:"; // tương tự — tiền tố nội bộ, không hiển thị ra ngoài
const TIEN_TO_SO_LAN_RUT_NGAY = "so-lan-rut-ngay:"; // đếm SỐ LƯỢT gửi yêu cầu rút trong ngày — tách riêng khỏi hạn mức coin/ngày
const SO_LAN_RUT_TOI_DA_NGAY = 1; // mỗi ngày chỉ được gửi 1 yêu cầu rút tiền, bất kể số coin
const COIN_QUY_DOI_DONG_MAU_SO = 100; // 100 coin = 1đ khi rút — coin giờ là đơn vị duy nhất, rút thẳng không cần đổi qua gem nữa
const PHI_RUT_TIEN_PHAN_TRAM = 0.10; // phí dịch vụ 10% mỗi lần rút — trừ trực tiếp vào số tiền quy đổi, KHÔNG đổi số coin bị trừ khỏi ví
const RUT_TOI_THIEU = 500000; // coin (~5.000đ) — tăng từ 200.000 lên 500.000
const RUT_TOI_DA_NGAY = 1800000; // coin / ngày (~18.000đ)
const RUT_TOI_DA_TUAN = 5000000; // coin / tuần (~50.000đ)
const TIEN_TO_LINK4M_SO_LAN_NGAY = "link4m-so-lan-ngay:"; // số lần hoàn thành nhiệm vụ link4m hôm nay
const LINK4M_GIOI_HAN_NGAY = 1; // chỉ 1 lần/ngày — mỗi lần hoàn thành tặng luôn 1 vé quay (xem xuLyXacNhanNhiemVu)
const TIEN_TO_LINK4M_LAN_CUOI = "link4m-lan-cuoi:"; // mốc thời gian hoàn thành nhiệm vụ link4m gần nhất — chặn vượt liên tục
const LINK4M_CHO_TOI_THIEU_MS = 0; // ĐÃ BỎ cooldown giữa 2 lần vượt link — chỉ còn giới hạn LINK4M_GIOI_HAN_NGAY lượt/ngày

// ==================================================
// 🔗 NHIỆM VỤ VƯỢT LINK TAPLAYMA — link rút gọn thứ 2, chạy SONG SONG với
// Link4M (khác endpoint, khác con trỏ nhiệm vụ, khác bộ đếm/giới hạn), để
// người chơi có thêm 1 nguồn kiếm coin + vé quay độc lập trong ngày. Dùng
// chung cơ chế mã 6 số tự host (trang /nvtp/<ma>) như Link4M vì Taplayma
// cũng không có API kiểm tra hoàn thành/reward.
// ==================================================
const TIEN_TO_TAPLAYMA_SO_LAN_NGAY = "taplayma-so-lan-ngay:"; // số lần hoàn thành nhiệm vụ Taplayma hôm nay
const TAPLAYMA_GIOI_HAN_NGAY = 4; // 4 lần/ngày
const TIEN_TO_TAPLAYMA_LAN_CUOI = "taplayma-lan-cuoi:"; // mốc thời gian hoàn thành gần nhất — dự phòng, không dùng để chặn cooldown
const TAPLAYMA_CHO_TOI_THIEU_MS = 0; // không cooldown giữa 2 lần vượt — chỉ giới hạn theo TAPLAYMA_GIOI_HAN_NGAY lượt/ngày
const TAPLAYMA_COIN_MIN = 2000; // mỗi lượt hoàn thành thưởng ngẫu nhiên 2000-2500 coin
const TAPLAYMA_COIN_MAX = 2500;
const TAPLAYMA_VE_QUAY_THUONG = 4; // tặng khi hoàn thành ĐỦ TAPLAYMA_GIOI_HAN_NGAY (4) lượt trong ngày
const KEY_CACHE_BANG_XEP_HANG = "cache-bang-xep-hang"; // JSON { kiem_xu, cap_nhat_luc } — làm mới mỗi 10 phút qua Cron Trigger
const KEY_MUA_GIAI = "mua-giai-bxh-hien-tai"; // JSON { bat_dau, ket_thuc } — mùa giải BXH hiện tại, tự mở mùa mới khi hết hạn
const MUA_GIAI_SO_NGAY = 7; // độ dài 1 mùa giải BXH (ngày)
const TOP_NHAN_THUONG = 10; // chỉ Top 10 mỗi bảng xếp hạng mới nhận thưởng khi kết thúc mùa giải — TỰ ĐỘNG trao ngay khi phát hiện mùa kết thúc, xem traoThuongMuaGiaiDaKetThucNeuCo()
const KEY_MUA_DA_TRAO_THUONG = "mua-da-trao-thuong"; // JSON { kiem_xu, moi_ban } — số mùa CUỐI CÙNG đã trao thưởng cho mỗi bảng, chặn trao trùng lặp
const PHAN_THUONG_KIEM_XU = [50000, 10000, 5000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]; // coin thưởng hạng 1→10, BXH "Đua Top Xu"
const PHAN_THUONG_MOI_BAN = [50000, 10000, 5000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]; // coin thưởng hạng 1→10, BXH "Đua Top Mời Bạn"
const MUC_TOI_THIEU_MOI_BAN = 3; // tối thiểu mời được 3 bạn (đã đạt Lv2 máy đào) TRONG MÙA mới lọt BXH
const MOI_BAN_MO_TU_MUA = 2; // BXH "Đua Top Mời Bạn" CHỈ xuất hiện từ mùa giải #2 trở đi — tức là sau khi
// mùa giải #1 (mùa đầu tiên, chỉ có BXH "Đua Top Xu") kết thúc. Trong suốt mùa #1, endpoint
// /bang-xep-hang trả về chua_mo=true cho loai=moi_ban thay vì bảng xếp hạng rỗng.
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
const GIFCODE_TU_DONG_COIN_MIN = 700;
const GIFCODE_TU_DONG_COIN_MAX = 1500;
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
// thủ công (/taogifcode) lẫn tự động (cron mỗi ngày). loiNhan là dòng tiêu
// đề tùy chỉnh (VD "🧧 GIFT CODE TẾT 2026!") do admin nhập ở tham số cuối
// cùng của /taogifcode — nếu không truyền/rỗng, mặc định "🎁 GIFT CODE NGẪU
// NHIÊN!" (áp dụng khi admin tạo tay không đặt lời nhắn riêng). Cron tự
// động mỗi ngày (taoGifcodeTuDong) luôn truyền tường minh "🎁 GIFT CODE MỖI
// NGÀY!" nên không rơi vào default này.
function xayDungTinGifcode(giftcode, loiNhan) {
  const dongThuong =
    giftcode.coinMin === giftcode.coinMax
      ? `${giftcode.coinMin.toLocaleString("vi-VN")} coin`
      : `${giftcode.coinMin.toLocaleString("vi-VN")} - ${giftcode.coinMax.toLocaleString("vi-VN")} coin (ngẫu nhiên)`;

  const tieuDe = (loiNhan && loiNhan.trim()) || "🎁 GIFT CODE NGẪU NHIÊN!";

  const dongVeQuay = giftcode.veQuayThuong > 0 ? `\n🎫 Kèm theo: +${giftcode.veQuayThuong.toLocaleString("vi-VN")} vé quay` : "";

  return (
    `${tieuDe}\n\n` +
    "✨ Cách nhận:\n" +
    "1️⃣ Mở app → vào tab Nhiệm vụ\n" +
    '2️⃣ Kéo xuống khối "🎁 Nhập Gift Code"\n' +
    "3️⃣ Bấm vào mã bên dưới để copy, rồi dán vào ô nhập mã\n\n" +
    `🎟️ Mã: \`${giftcode.code}\`\n` +
    `🪙 Thưởng: ${dongThuong}${dongVeQuay}\n` +
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

  // Cron tự động luôn dùng tiêu đề "GIFT CODE MỖI NGÀY!" — khác với mặc
  // định "GIFT CODE NGẪU NHIÊN!" áp dụng khi admin gõ /taogifcode tay mà
  // không nhập loi_nhan.
  const tinNhan = xayDungTinGifcode(giftcodeMoi, "🎁 GIFT CODE MỖI NGÀY!");
  const linkBot = env.LINK_BOT || "https://t.me/vuacaytien_bot";

  // Chỉ gửi vào NHÓM TRÒ CHUYỆN — không gửi vào kênh thông báo nữa.
  const diaChiGui = [];
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
const COIN_DAO_MOI_GIO = 250; // coin/giờ ở cấp 1 (chưa cộng bonus)
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

// ==================================================
// 🛒 CỬA HÀNG — coin sink, dùng coin đã kiếm mua vật phẩm hỗ trợ. Trạng
// thái vật phẩm lưu thẳng trong object user (nguoiDung.boostDao,
// nguoiDung.baoVeChuoiSoLuong) — không cần bảng riêng.
// ==================================================
const BOOST_DAO_THOI_GIAN_MS = 24 * 60 * 60 * 1000; // hiệu lực 24 giờ / lần mua
const BOOST_DAO_HE_SO = 2; // nhân đôi tốc độ đào trong lúc hiệu lực
const BOOST_DAO_GIA = 7000; // coin
const BAO_VE_CHUOI_GIA = 5000; // coin / lượt
const BAO_VE_CHUOI_TOI_DA = 5; // tối đa tích trữ 5 lượt bảo vệ chuỗi cùng lúc

const SHOP_VAT_PHAM = {
  boost_dao_x2: {
    ma: "boost_dao_x2",
    ten: "Tăng Tốc Đào x2",
    icon: "⚡",
    moTa: "Nhân đôi tốc độ đào coin trong 24 giờ liên tục kể từ lúc kích hoạt.",
    gia: BOOST_DAO_GIA,
  },
  bao_ve_chuoi: {
    ma: "bao_ve_chuoi",
    ten: "Bảo Vệ Chuỗi Điểm Danh",
    icon: "🛡️",
    moTa: "Lỡ quên điểm danh 1 ngày cũng không bị reset chuỗi. Tự động dùng 1 lượt khi cần, có thể mua tích trữ nhiều lượt.",
    gia: BAO_VE_CHUOI_GIA,
  },
};

// ==================================================
// 🎡 VÒNG QUAY MAY MẮN — tab "Làm thêm". Người chơi tiêu 1 "vé quay"
// (nguoiDung.veQuay) mỗi lần quay, random có trọng số 1 trong các ô thưởng
// coin bên dưới. Vé quay được TẶNG (không bán) — cứ hoàn thành đủ
// LINK4M_GIOI_HAN_NGAY (1) lượt "Nhiệm vụ thêm — Vượt link Link4M" trong
// ngày là được +1 vé, xem chỗ cộng trong xuLyXacNhanNhiemVu() bên dưới.
// ==================================================
// 10 ô, tổng trọng số = 100 (dễ đọc = %):
//   - Ô "Chúc may mắn"          → trongSo 50  → 50%
//   - 7 ô coin 100-1000         → tổng 40     → 40% (chia không đều cho lẻ)
//   - 2 ô coin 5000/10000       → tổng 10     → 10%
// trongSo không hiển thị ra frontend nên tỷ lệ thật không lộ cho người chơi.
const CAU_HINH_VONG_QUAY = [
  { coin: 100, trongSo: 8 },   // ô 1
  { coin: 200, trongSo: 8 },   // ô 2
  { coin: 300, trongSo: 8 },   // ô 3
  { coin: 500, trongSo: 8 },   // ô 4
  { coin: 700, trongSo: 12 },  // ô 5
  { coin: 900, trongSo: 8 },   // ô 6
  { coin: 1000, trongSo: 8 },  // ô 7
  { coin: 5000, trongSo: 5 },   // ô 8 (5%)
  { coin: 10000, trongSo: 5 },  // ô 9 (5%)
  { coin: 0, trongSo: 30, nhan: "Chúc may mắn" }, // ô 10 (30%)
];

// Random 1 chỉ số trong CAU_HINH_VONG_QUAY theo trọng số (trongSo càng cao
// càng dễ trúng) — trả về index (0-based), khớp thứ tự hiển thị trên
// vòng quay phía frontend để animation dừng đúng ô đã trúng.
function quayNgauNhienChiSo(cauHinh) {
  const tongTrongSo = cauHinh.reduce((s, o) => s + o.trongSo, 0);
  let r = Math.random() * tongTrongSo;
  for (let i = 0; i < cauHinh.length; i++) {
    r -= cauHinh[i].trongSo;
    if (r <= 0) return i;
  }
  return cauHinh.length - 1;
}

// XP cần để lên tiếp 1 cấp, tính từ cấp hiện tại: cấp 1→2 cần 500, cấp 2→3
// cần 1.000, cấp 3→4 cần 1.500, v.v. (mỗi cấp sau tăng thêm 500 XP).
function xpCanChoCapTiepTheo(capHienTai) {
  return XP_DAO_MOI_CAP_KHOI_DIEM * capHienTai;
}

// Tốc độ đào hiện tại (coin/giờ) theo cấp — cấp 1 = tốc độ gốc, mỗi cấp
// trên cấp 1 cộng thêm 10%.
function tocDoDaoMoiGio(nguoiDung) {
  const cap = nguoiDung.capDao || 1;
  let toc = COIN_DAO_MOI_GIO * (1 + TANG_TOC_DO_MOI_CAP * (cap - 1));
  if (nguoiDung.boostDao && nguoiDung.boostDao.hetHanLuc > Date.now()) {
    toc *= nguoiDung.boostDao.heSo || 1;
  }
  return toc;
}

// Vật phẩm "Tăng Tốc Đào x2" còn hiệu lực bao lâu — trả về null nếu không
// có / đã hết hạn. Dùng ở cả /trang-thai-dao (hiển thị) và /shop-thong-tin.
function thongTinBoostDaoDeTra(nguoiDung) {
  if (!nguoiDung.boostDao || nguoiDung.boostDao.hetHanLuc <= Date.now()) return null;
  return { he_so: nguoiDung.boostDao.heSo, het_han_luc: nguoiDung.boostDao.hetHanLuc };
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

  await congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung); // chỉ tính vào BXH Mời Bạn nếu vừa đạt Lv2 (KHÔNG cộng thêm coin)

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
    boost_dao: thongTinBoostDaoDeTra(nguoiDung),
    ve_quay: nguoiDung.veQuay || 0, // số vé quay hiện có — hiển thị ở balo cạnh coin trên header
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
// 📈 BỘ ĐẾM NHIỆM VỤ TOÀN CỤC — cộng dồn all-time, phục vụ /checknv.
// Đơn giản là đọc-rồi-ghi-đè (không atomic tuyệt đối), CHẤP NHẬN ĐƯỢC vì
// đây chỉ là số liệu thống kê tham khảo cho admin, không ảnh hưởng tới
// coin hay quyền lợi của user — giống cách các counter *-so-lan-ngay:
// khác trong file này vẫn đang làm.
async function tangBoDemToanCuc(env, key) {
  const hienTai = Number((await env.ADMINS.get(key)) || 0);
  await env.ADMINS.put(key, String(hienTai + 1));
}

async function layBoDemToanCuc(env, key) {
  return Number((await env.ADMINS.get(key)) || 0);
}

// Tăng bộ đếm THEO NGÀY (khác tangBoDemToanCuc — bộ đếm đó cộng dồn mãi
// mãi, còn bộ đếm này tách riêng theo từng ngày để /checknv có thể hiển
// thị số liệu 7 ngày gần nhất thay vì 1 con số tổng all-time).
async function tangBoDemNgay(env, tienTo, ngay) {
  const key = tienTo + ngay;
  const hienTai = Number((await env.ADMINS.get(key)) || 0);
  await env.ADMINS.put(key, String(hienTai + 1));
}

async function layBoDemNgay(env, tienTo, ngay) {
  return Number((await env.ADMINS.get(tienTo + ngay)) || 0);
}

// Gộp số liệu 3 bộ đếm ngày (QC Monetag, Adsgram, Link4M) cho
// SO_NGAY_THONG_KE_NHIEM_VU ngày gần nhất — mới nhất (hôm nay) đứng đầu
// mảng trả về. Dùng chung cho cả lệnh Telegram /checknv lẫn lệnh web admin.
async function layThongKeNhiemVuNgay(env) {
  const ketQua = [];
  let ngay = ngayVnHomNay();
  for (let i = 0; i < SO_NGAY_THONG_KE_NHIEM_VU; i++) {
    const qc = await layBoDemNgay(env, TIEN_TO_QC_NGAY_TK, ngay);
    const adsgram = await layBoDemNgay(env, TIEN_TO_ADSGRAM_NGAY_TK, ngay);
    const link4m = await layBoDemNgay(env, TIEN_TO_LINK4M_NGAY_TK, ngay);
    const taplayma = await layBoDemNgay(env, TIEN_TO_TAPLAYMA_NGAY_TK, ngay);
    const bbmkts = await layBoDemNgay(env, TIEN_TO_BBMKTS_NGAY_TK, ngay);
    const layma = await layBoDemNgay(env, TIEN_TO_LAYMA_NGAY_TK, ngay);
    ketQua.push({ ngay, qc, adsgram, link4m, taplayma, bbmkts, layma });
    ngay = ngayTruocVN(ngay);
  }
  return ketQua;
}

// Dựng nội dung text hiển thị bảng 7 ngày — dùng chung cho cả Telegram lẫn web admin.
function dinhDangThongKeNhiemVuNgay(thongKe) {
  const dong = thongKe.map((d) => {
    const tongQcNgay = d.qc + d.adsgram;
    return (
      `📅 ${d.ngay}\n` +
      `   🎬 Monetag: ${d.qc.toLocaleString("vi-VN")} | 🎥 Adsgram: ${d.adsgram.toLocaleString("vi-VN")} | 📺 Tổng QC: ${tongQcNgay.toLocaleString("vi-VN")}\n` +
      `   🔗 Link4M: ${d.link4m.toLocaleString("vi-VN")} | 🔗 Taplayma: ${(d.taplayma || 0).toLocaleString("vi-VN")} | 🔗 bbmkts: ${(d.bbmkts || 0).toLocaleString("vi-VN")} | 🔗 Layma: ${(d.layma || 0).toLocaleString("vi-VN")}`
    );
  });

  const tongQc7Ngay = thongKe.reduce((s, d) => s + d.qc, 0);
  const tongAdsgram7Ngay = thongKe.reduce((s, d) => s + d.adsgram, 0);
  const tongLink4m7Ngay = thongKe.reduce((s, d) => s + d.link4m, 0);
  const tongTaplayma7Ngay = thongKe.reduce((s, d) => s + (d.taplayma || 0), 0);
  const tongBbmkts7Ngay = thongKe.reduce((s, d) => s + (d.bbmkts || 0), 0);
  const tongLayma7Ngay = thongKe.reduce((s, d) => s + (d.layma || 0), 0);

  return (
    `📊 THỐNG KÊ NHIỆM VỤ (${thongKe.length} NGÀY GẦN NHẤT)\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    dong.join("\n\n") +
    `\n━━━━━━━━━━━━━━━━━━\n` +
    `Σ ${thongKe.length} ngày — 🎬 ${tongQc7Ngay.toLocaleString("vi-VN")} | 🎥 ${tongAdsgram7Ngay.toLocaleString("vi-VN")} | 📺 ${(tongQc7Ngay + tongAdsgram7Ngay).toLocaleString("vi-VN")} | 🔗 Link4M ${tongLink4m7Ngay.toLocaleString("vi-VN")} | 🔗 Taplayma ${tongTaplayma7Ngay.toLocaleString("vi-VN")} | 🔗 bbmkts ${tongBbmkts7Ngay.toLocaleString("vi-VN")} | 🔗 Layma ${tongLayma7Ngay.toLocaleString("vi-VN")}`
  );
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

  // 🏆 Số xu kiếm được TRONG MÙA GIẢI BXH hiện tại — dùng chung cơ chế "mốc
  // mùa giải" với /bang-xep-hang (damBaoMocMuaGiai): điểm BXH = tổng đã kiếm
  // lũy kế trừ đi mốc chụp tại thời điểm mùa hiện tại bắt đầu, KHÔNG phải
  // tổng đã kiếm cả đời. Đọc thêm cache để biết hạng hiện tại (nếu đã lọt
  // Top 50 được cache), không bắt buộc phải có mới hiển thị được số xu.
  const muaGiai = await layHoacTaoMuaGiai(env);
  const coinChoBXH = nguoiDung.tongDaKiem != null ? nguoiDung.tongDaKiem : nguoiDung.coin || 0;
  const mocMuaGiai = await damBaoMocMuaGiai(env, uid, nguoiDung, muaGiai.so);
  const daKiemTrongMua = Math.max(0, coinChoBXH - mocMuaGiai.coin_goc);
  const duDieuKienBXH = daKiemTrongMua >= MUC_TOI_THIEU_KIEM_XU;

  let hangHienTai = null;
  try {
    const rawCache = await env.USERS.get(KEY_CACHE_BANG_XEP_HANG);
    const cache = rawCache ? JSON.parse(rawCache) : null;
    if (cache && cache.so_mua === muaGiai.so && Array.isArray(cache.kiem_xu)) {
      const idx = cache.kiem_xu.findIndex((nd) => String(nd.uid) === String(uid));
      if (idx >= 0) hangHienTai = idx + 1;
    }
  } catch (e) {
    // cache lỗi/thiếu — bỏ qua, vẫn hiển thị được số xu tính trực tiếp ở trên
  }

  let dongTrangThaiBXH;
  if (hangHienTai) {
    dongTrangThaiBXH = `📍 Đang xếp hạng #${hangHienTai} trong BXH`;
  } else if (duDieuKienBXH) {
    dongTrangThaiBXH = `📍 Đủ điều kiện vào BXH, đợi cache cập nhật (tối đa 10 phút/lần)`;
  } else {
    dongTrangThaiBXH = `📍 Chưa đủ điều kiện vào BXH`;
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
    `🏆 Mùa giải BXH #${muaGiai.so}\n` +
    `🏆 Đã kiếm trong mùa: ${daKiemTrongMua.toLocaleString("vi-VN")} xu (tối thiểu ${MUC_TOI_THIEU_KIEM_XU.toLocaleString("vi-VN")} xu để vào BXH)\n` +
    `${dongTrangThaiBXH}\n\n` +
    `👤 Được giới thiệu bởi (UID): ${nguoiDung.gioiThieuBoi || "Không có"}\n` +
    `👥 Số bạn đã mời: ${danhSachBanBe.length}\n\n` +
    `💳 Tài khoản nhận tiền: ${
      taiKhoan ? `${taiKhoan.nganHang} - ${taiKhoan.soTk} (${taiKhoan.tenNguoiNhan})` : "Chưa liên kết"
    }\n` +
    `💸 Đã rút hôm nay: ${daRutNgay.toLocaleString("vi-VN")} coin (${soLanDaRutHomNay}/${SO_LAN_RUT_TOI_DA_NGAY} lượt)\n` +
    `💸 Đã rút tuần này: ${daRutTuan.toLocaleString("vi-VN")} coin`;

  return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text });
}

// /lammoibxh — ÉP tính lại + ghi cache bảng xếp hạng NGAY LẬP TỨC, không
// cần chờ Cron Trigger (tối đa 10 phút/lần). Hữu ích để: (1) kiểm tra ngay
// xem code tính BXH có lỗi gì không thay vì phải đoán qua việc chờ đợi;
// (2) admin có thể tự làm mới thủ công nếu nghi ngờ Cron Trigger chưa chạy
// hoặc chạy lỗi. Trả về đầy đủ lỗi (nếu có) + top 5 để đối chiếu nhanh.
async function xuLyLamMoiBangXepHang(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⏳ Đang làm mới bảng xếp hạng..." });

  try {
    // Kiểm tra + trao thưởng Top 10 TRƯỚC nếu cache hiện tại đang giữ bảng
    // xếp hạng cuối cùng của 1 mùa vừa kết thúc — nếu làm mới cache trước,
    // dữ liệu mùa cũ sẽ bị ghi đè mất, không còn gì để trao thưởng nữa.
    await traoThuongMuaGiaiDaKetThucNeuCo(env);

    const muaGiai = await layHoacTaoMuaGiai(env);
    const ketQua = await lamMoiCacheBangXepHang(env, muaGiai);
    const danhSach = ketQua.kiem_xu || [];

    const top5 = danhSach.length
      ? danhSach
          .slice(0, 5)
          .map((nd, idx) => `${idx + 1}. ${nd.ten} — ${nd.gia_tri.toLocaleString("vi-VN")} xu`)
          .join("\n")
      : "(chưa có ai đủ điều kiện tối thiểu để lọt BXH)";

    const capNhatLuc = new Date(ketQua.cap_nhat_luc).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        `✅ Đã làm mới xong bảng xếp hạng!\n\n` +
        `🏆 Mùa giải #${ketQua.so_mua}\n` +
        `👥 Tổng số người đủ điều kiện vào BXH: ${danhSach.length}\n` +
        `🕒 Cập nhật lúc: ${capNhatLuc}\n\n` +
        `🏅 Top 5:\n${top5}`,
    });
  } catch (e) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `❌ Lỗi khi làm mới BXH:\n${String(e)}`,
    });
  }
}

// /checknv — xem NHANH số lượt nhiệm vụ đã hoàn thành theo TỪNG NGÀY, tối
// đa 7 ngày gần nhất (KHÔNG còn cộng dồn all-time như trước) — quảng cáo
// Monetag, quảng cáo Adsgram, và vượt link Link4M. Đọc thẳng các bộ đếm
// theo ngày (TIEN_TO_QC_NGAY_TK / TIEN_TO_ADSGRAM_NGAY_TK /
// TIEN_TO_LINK4M_NGAY_TK), không cần quét lại toàn bộ user nên trả lời
// gần như tức thì.
async function xuLyCheckNhiemVu(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const thongKe = await layThongKeNhiemVuNgay(env);
  const text = dinhDangThongKeNhiemVuNgay(thongKe);

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
  { lenh: "/tucam [tu_khoa]", moTa: "Thêm từ khóa cấm để bot tự động xóa tin chứa từ đó trong nhóm. /tucam ds xem danh sách, /tucam xoa [tu_khoa] để xóa" },
  { lenh: "/tucam18 [tu_khoa]", moTa: "Thêm từ khóa 18+ để bot tự động xóa tin (kể cả chữ trong ảnh) — tự bắt được biến thể không dấu/chèn ký tự/teencode/lặp chữ. /tucam18 ds xem danh sách, /tucam18 xoa [tu_khoa] để xóa" },
  { lenh: "/mute [so_phut]", moTa: "Trả lời (reply) tin nhắn người cần mute, tắt quyền gửi tin trong nhóm X phút (mặc định 30)" },
  { lenh: "/unmute", moTa: "Trả lời (reply) tin nhắn người cần gỡ mute, hoặc /unmute [uid] — mở lại quyền gửi tin ngay, không cần chờ hết hạn" },
  { lenh: "/ban [so_phut]", moTa: "Trả lời (reply) tin nhắn người cần ban, cấm vào nhóm X phút (mặc định 30)" },
  { lenh: "/unban", moTa: "Trả lời (reply) tin nhắn người cần gỡ ban, hoặc /unban [uid] — cho vào lại nhóm ngay qua link mời" },
  { lenh: "/taogifcode [coin hoặc min-max] [code] [so_luot] [veN] [loi_nhan]", moTa: "Tạo gift code mới, tự thông báo vào nhóm. veN (VD ve5) tuỳ chọn — tặng kèm N vé quay/lượt nhập. loi_nhan tùy chọn — không nhập thì mặc định \"🎁 GIFT CODE NGẪU NHIÊN!\"" },
  { lenh: "/checkcode", moTa: "Xem danh sách các gift code đã tạo" },
  { lenh: "/checkcodesl [code]", moTa: "Xem chi tiết + số người đã nhập 1 gift code" },
  { lenh: "/xoacode [code]", moTa: "Xóa VĨNH VIỄN 1 gift code ngay cả khi CHƯA hết lượt nhập — mã sẽ không dùng được nữa" },
  { lenh: "/gui", moTa: "Trả lời 1 tin nhắn kèm lệnh này để broadcast tới toàn bộ user" },
  { lenh: "/sluser", moTa: "Xem tổng số user đã /start với bot" },
  { lenh: "/check [ID]", moTa: "Xem toàn bộ thông tin 1 người chơi (coin, cấp đào, điểm danh, xu BXH mùa hiện tại, ví, bạn bè...)" },
  { lenh: "/lammoibxh", moTa: "Ép tính lại + ghi cache BXH ngay lập tức, không cần chờ Cron Trigger" },
  { lenh: "/checknv", moTa: "Xem số lượt QC (Monetag+Adsgram) và vượt link Link4M đã hoàn thành, theo TỪNG NGÀY (7 ngày gần nhất)" },
  { lenh: "/id", moTa: "(Ai cũng dùng được) Trả về ID cuộc trò chuyện; trả lời 1 tin nhắn kèm lệnh này để lấy ID người được trả lời" },
  { lenh: "/dslenh", moTa: "Xem danh sách lệnh admin này" },
];

// Escape các ký tự có ý nghĩa đặc biệt trong parse_mode "Markdown" (legacy)
// của Telegram — "_" (in nghiêng), "*" (in đậm), "`" (code), "[" (link) —
// khi xuất hiện trong VĂN BẢN THƯỜNG (ngoài các đoạn code `...` đã tự động
// không bị parse thêm). Cần dùng cho moTa vì các mô tả lệnh có chứa "_"
// (vd "tu_khoa", "loi_nhan") — nếu để nguyên, tin nhắn có SỐ LẺ dấu "_" sẽ
// khiến Telegram trả lỗi "can't parse entities" và KHÔNG GỬI ĐƯỢC TOÀN BỘ
// tin nhắn (silent fail, telegramApi() không throw nên admin không thấy
// lỗi gì — đây chính là nguyên nhân /dslenh trước đây "không hoạt động").
function thoatMarkdownDon(chuoi) {
  return String(chuoi ?? "").replace(/([_*`[])/g, "\\$1");
}

async function xuLyDsLenh(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const text =
    "🛠️ DANH SÁCH LỆNH ADMIN:\n\n" +
    DANH_SACH_LENH_ADMIN.map((l, idx) => `${idx + 1}. \`${l.lenh}\`\n   ${thoatMarkdownDon(l.moTa)}`).join("\n\n");

  const ketQua = await telegramApi(env, "sendMessage", { chat_id: message.chat.id, text, parse_mode: "Markdown" });

  // Lớp phòng vệ: nếu Markdown vẫn lỗi vì lý do khác (vd escape sót), gửi
  // lại bằng PLAIN TEXT (bỏ parse_mode) thay vì im lặng thất bại — admin
  // luôn nhận được danh sách lệnh dù định dạng có thể kém đẹp hơn 1 chút.
  if (!ketQua || !ketQua.ok) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text });
  }
  return ketQua;
}

// /id — lấy ID cuộc trò chuyện hiện tại (chat riêng, nhóm, hoặc kênh).
// Nếu gõ lệnh này kèm TRẢ LỜI (reply) 1 tin nhắn khác, sẽ trả về ID của
// người được trả lời thay vì ID cuộc trò chuyện. Trả lời ngắn gọn 1 dòng,
// giống kiểu bot Rose. Lệnh này KHÔNG giới hạn admin — user thường cũng
// gõ được.
async function xuLyLayId(env, message) {
  const reply = message.reply_to_message;

  if (reply && reply.from) {
    const tenReply = reply.from.first_name || reply.from.username || "Người dùng";
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `ID của ${tenReply} là: \`${reply.from.id}\``,
      parse_mode: "Markdown",
    });
  }

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `ID cuộc trò chuyện này là: \`${message.chat.id}\``,
    parse_mode: "Markdown",
  });
}


// /mute [phut] — reply tin nhắn người cần mute, tắt quyền gửi tin của họ
// trong nhóm hiện tại trong X phút (mặc định 30). Dùng restrictChatMember —
// Telegram tự khôi phục quyền khi hết hạn; dùng /unmute (xem bên dưới) nếu
// cần gỡ SỚM hơn, trước khi hết hạn hoặc lỡ mute nhầm người.
async function xuLyMute(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }
  if (loaiChat(message) !== "👥 NHÓM") {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Lệnh này chỉ dùng được trong nhóm." });
  }
  const reply = message.reply_to_message;
  if (!reply || !reply.from) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Trả lời (reply) tin nhắn người cần mute kèm lệnh /mute [so_phut]." });
  }

  const phan = message.text.trim().split(/\s+/);
  const phut = phan[1] ? Number(phan[1]) : 30;
  if (!Number.isFinite(phut) || !Number.isInteger(phut) || phut <= 0) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Số phút không hợp lệ. Dùng: /mute [so_phut] (mặc định 30)." });
  }

  // Tối thiểu 31 giây — Telegram coi restrict dưới 30 giây kể từ hiện tại
  // là VĨNH VIỄN thay vì tạm thời (xem docs restrictChatMember). Input đã
  // bị chặn ở phut<=0 phía trên nên hiện tại luôn ≥60s rồi, giữ Math.max ở
  // đây chỉ để phòng thủ nếu sau này đổi validate, đồng bộ cách làm với
  // xuLyBan() bên dưới.
  const untilDate = Math.floor(Date.now() / 1000) + Math.max(phut * 60, 31);
  const kq = await telegramApi(env, "restrictChatMember", {
    chat_id: message.chat.id,
    user_id: reply.from.id,
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
    until_date: untilDate,
  });

  if (!kq || !kq.ok) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `❌ Không mute được. Kiểm tra bot đã là admin nhóm kèm quyền "Restrict members" chưa.\n${kq && kq.description ? "Lỗi: " + kq.description : ""}`,
    });
  }

  const ten = reply.from.first_name || reply.from.username || String(reply.from.id);
  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `🔇 Đã mute ${ten} (ID: ${reply.from.id}) trong ${phut} phút.\nTự mở lại lúc: ${new Date(untilDate * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
  });
}

// /ban [phut] — reply tin nhắn người cần ban, cấm vào nhóm trong X phút
// (mặc định 30). Dùng banChatMember với until_date — Telegram Bot API yêu
// cầu until_date tối thiểu ~30 giây kể từ hiện tại, dưới mức đó bị hiểu là
// cấm vĩnh viễn, nên chặn số phút quá nhỏ.
async function xuLyBan(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }
  if (loaiChat(message) !== "👥 NHÓM") {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Lệnh này chỉ dùng được trong nhóm." });
  }
  const reply = message.reply_to_message;
  if (!reply || !reply.from) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Trả lời (reply) tin nhắn người cần ban kèm lệnh /ban [so_phut]." });
  }

  const phan = message.text.trim().split(/\s+/);
  const phut = phan[1] ? Number(phan[1]) : 30;
  if (!Number.isFinite(phut) || !Number.isInteger(phut) || phut <= 0) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Số phút không hợp lệ. Dùng: /ban [so_phut] (mặc định 30)." });
  }

  const untilDate = Math.floor(Date.now() / 1000) + Math.max(phut * 60, 31);
  const kq = await telegramApi(env, "banChatMember", {
    chat_id: message.chat.id,
    user_id: reply.from.id,
    until_date: untilDate,
  });

  if (!kq || !kq.ok) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `❌ Không ban được. Kiểm tra bot đã là admin nhóm kèm quyền "Ban users" chưa.\n${kq && kq.description ? "Lỗi: " + kq.description : ""}`,
    });
  }

  const ten = reply.from.first_name || reply.from.username || String(reply.from.id);
  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `🚫 Đã ban ${ten} (ID: ${reply.from.id}) trong ${phut} phút.\nCó thể vào lại (cần link mời) từ: ${new Date(untilDate * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
  });
}

// ==================================================
// 🔓 /unmute, /unban — gỡ SỚM trước khi hết hạn tự động (hoặc gỡ khi lỡ
// mute/ban nhầm người), thay vì buộc phải chờ hết đúng số phút đã đặt lúc
// /mute, /ban. Cả 2 lệnh chấp nhận HOẶC trả lời (reply) tin nhắn người cần
// gỡ (giống /mute, /ban) HOẶC truyền thẳng UID làm tham số đầu tiên (vd
// "/unban 123456789") — hữu ích nhất cho /unban, vì người vừa bị ban
// thường không còn tin nhắn gần đây nào trong nhóm để admin reply tới.
// ==================================================

// Xác định UID + tên hiển thị của người cần gỡ mute/ban — ưu tiên tin nhắn
// đang được reply (có tên thật từ Telegram); nếu không reply thì thử đọc
// tham số đầu tiên như 1 UID số nguyên. Khi chỉ có UID trần (không reply),
// tra thêm tên đã lưu trong dữ liệu app (layNguoiDung) để hiển thị đẹp hơn
// — tra không ra vẫn dùng UID làm tên, không chặn thao tác vì lý do này.
async function layMucTieuGoTru(env, message, phan) {
  const reply = message.reply_to_message;
  if (reply && reply.from) {
    return { uid: reply.from.id, ten: reply.from.first_name || reply.from.username || String(reply.from.id) };
  }

  const uidTho = phan[1];
  if (!uidTho || !/^\d+$/.test(uidTho)) return null;

  const uid = Number(uidTho);
  let ten = uidTho;
  try {
    const nd = await layNguoiDung(env, String(uid));
    if (nd) ten = (nd.ten && nd.ten.trim()) || (nd.username ? "@" + nd.username : ten);
  } catch (e) {
    // không tra được tên trong dữ liệu app (hiếm) — vẫn dùng UID làm tên hiển thị
  }
  return { uid, ten };
}

// Quyền "mở toàn bộ" dùng làm DỰ PHÒNG cho /unmute khi không đọc được
// quyền mặc định thật của nhóm (vd lỗi mạng gọi getChat) — set về true
// đúng những field mà xuLyMute() đã đặt false, để gỡ sạch giới hạn đã áp.
const QUYEN_MO_TOAN_BO_DU_PHONG = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

// Đọc quyền MẶC ĐỊNH hiện tại của nhóm (permissions áp dụng cho thành viên
// thường) qua getChat — /unmute khôi phục ĐÚNG về quyền này thay vì mở
// toàn bộ, để không vô tình cấp dư quyền so với các thành viên khác (vd
// nhóm đã tắt "Gửi bình chọn" cho tất cả thành viên thì gỡ mute cũng không
// nên mở riêng quyền đó cho 1 người). Lỗi mạng/API → dùng quyền dự phòng.
async function layQuyenMacDinhNhom(env, chatId) {
  try {
    const kq = await telegramApi(env, "getChat", { chat_id: chatId });
    if (kq && kq.ok && kq.result && kq.result.permissions) {
      return kq.result.permissions;
    }
  } catch (e) {
    // rơi xuống dùng quyền dự phòng bên dưới
  }
  return QUYEN_MO_TOAN_BO_DU_PHONG;
}

// /unmute — reply tin nhắn người cần gỡ mute, HOẶC /unmute [uid].
async function xuLyUnmute(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }
  if (loaiChat(message) !== "👥 NHÓM") {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Lệnh này chỉ dùng được trong nhóm." });
  }

  const phan = message.text.trim().split(/\s+/);
  const mucTieu = await layMucTieuGoTru(env, message, phan);
  if (!mucTieu) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "⚠️ Trả lời (reply) tin nhắn người cần gỡ mute, hoặc dùng /unmute [uid].",
    });
  }

  const quyen = await layQuyenMacDinhNhom(env, message.chat.id);
  const kq = await telegramApi(env, "restrictChatMember", {
    chat_id: message.chat.id,
    user_id: mucTieu.uid,
    permissions: quyen,
  });

  if (!kq || !kq.ok) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `❌ Không gỡ mute được. Kiểm tra bot đã là admin nhóm kèm quyền "Restrict members" chưa.\n${kq && kq.description ? "Lỗi: " + kq.description : ""}`,
    });
  }

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `🔊 Đã gỡ mute cho ${mucTieu.ten} (ID: ${mucTieu.uid}). Có thể gửi tin nhắn bình thường trở lại ngay.`,
  });
}

// /unban — reply tin nhắn người cần gỡ ban, HOẶC /unban [uid] (thường dùng
// cách này hơn vì người bị ban hiếm khi còn tin nhắn để reply). Dùng
// unbanChatMember với only_if_banned=true — BẮT BUỘC truyền tham số này:
// thiếu nó, nếu lỡ gọi /unban cho 1 người ĐANG là thành viên bình thường
// (chưa từng bị ban), Telegram sẽ hiểu thành lệnh "kick" và ĐUỔI LUÔN
// người đó khỏi nhóm thay vì không làm gì cả — xem docs unbanChatMember.
async function xuLyUnban(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }
  if (loaiChat(message) !== "👥 NHÓM") {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Lệnh này chỉ dùng được trong nhóm." });
  }

  const phan = message.text.trim().split(/\s+/);
  const mucTieu = await layMucTieuGoTru(env, message, phan);
  if (!mucTieu) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "⚠️ Trả lời (reply) tin nhắn người cần gỡ ban, hoặc dùng /unban [uid].",
    });
  }

  const kq = await telegramApi(env, "unbanChatMember", {
    chat_id: message.chat.id,
    user_id: mucTieu.uid,
    only_if_banned: true,
  });

  if (!kq || !kq.ok) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `❌ Không gỡ ban được. Kiểm tra bot đã là admin nhóm kèm quyền "Ban users" chưa.\n${kq && kq.description ? "Lỗi: " + kq.description : ""}`,
    });
  }

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `✅ Đã gỡ ban cho ${mucTieu.ten} (ID: ${mucTieu.uid}). Người này có thể vào lại nhóm qua link mời.`,
  });
}


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

// /tucam [tu_khoa] — thêm từ khóa cấm mới (khớp NGUYÊN TỪ, không phân biệt
// hoa/thường) vào danh sách TÙY CHỈNH, gộp thêm vào DANH_SACH_TU_KHOA_CAM cố
// định trong code khi lọc tin nhắn nhóm (xem coTuCamTrongTinNhan).
// /tucam ds — liệt kê toàn bộ từ khóa cấm hiện tại (cố định + tùy chỉnh).
// /tucam xoa [tu_khoa] — xóa 1 từ khóa khỏi danh sách tùy chỉnh (không xóa
// được từ khóa cố định viết sẵn trong code, chỉ xóa được từ đã thêm qua lệnh này).
async function xuLyTuCam(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const phan = message.text.trim().split(/\s+/);
  const hanhDongTho = (phan[1] || "").toLowerCase();

  if (!phan[1]) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        "⚠️ Dùng:\n" +
        "/tucam [tu_khoa] — thêm từ khóa cấm mới\n" +
        "/tucam ds — xem danh sách từ khóa cấm hiện tại\n" +
        "/tucam xoa [tu_khoa] — xóa 1 từ khóa cấm đã thêm",
    });
  }

  if (hanhDongTho === "ds") {
    const tuyChinh = await layTuKhoaCamTuyChinh(env);
    const text =
      `🚫 TỪ KHOÁ CẤM CỐ ĐỊNH (${DANH_SACH_TU_KHOA_CAM.length}):\n` +
      DANH_SACH_TU_KHOA_CAM.map((t, i) => `${i + 1}. ${t}`).join("\n") +
      `\n\n➕ TỪ KHOÁ CẤM TÙY CHỈNH (${tuyChinh.length}):\n` +
      (tuyChinh.length ? tuyChinh.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(chưa có)");
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text });
  }

  if (hanhDongTho === "xoa") {
    const tuXoa = phan.slice(2).join(" ").trim();
    if (!tuXoa) {
      return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /tucam xoa [tu_khoa]" });
    }
    const tuyChinh = await layTuKhoaCamTuyChinh(env);
    const idx = tuyChinh.findIndex((t) => t.toLowerCase() === tuXoa.toLowerCase());
    if (idx === -1) {
      return telegramApi(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `❌ Không tìm thấy "${tuXoa}" trong danh sách tùy chỉnh (chỉ xóa được từ đã thêm qua /tucam).`,
      });
    }
    tuyChinh.splice(idx, 1);
    await luuTuKhoaCamTuyChinh(env, tuyChinh);
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `✅ Đã xóa từ khóa cấm: "${tuXoa}"` });
  }

  // Mặc định: THÊM MỚI — lấy nguyên phần còn lại của tin nhắn sau /tucam
  // (giữ được khoảng trắng bên trong, vd "trang cá nhân").
  const tuMoi = phan.slice(1).join(" ").trim();

  const toanBo = await layToanBoTuKhoaCam(env);
  if (toanBo.some((t) => t.toLowerCase() === tuMoi.toLowerCase())) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `⚠️ Từ khóa "${tuMoi}" đã có trong danh sách cấm rồi.` });
  }

  const tuyChinh = await layTuKhoaCamTuyChinh(env);
  tuyChinh.push(tuMoi);
  await luuTuKhoaCamTuyChinh(env, tuyChinh);

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `✅ Đã thêm từ khóa cấm: "${tuMoi}"\nTừ giờ tin nhắn trong nhóm chứa từ này (khớp nguyên từ) sẽ tự động bị xóa.`,
  });
}

// /tucam18 [tu_khoa] — thêm từ khóa 18+ mới vào danh sách kiểm duyệt nội
// dung nhạy cảm. KHÁC /tucam ở chỗ: so khớp qua chuanHoaChongNeLoc() (bỏ
// dấu, gộp teencode số→chữ, xoá ký tự chèn xen, rút gọn lặp) rồi so
// SUBSTRING — nên 1 từ khoá bắt được luôn các biến thể né lọc thường gặp
// (không dấu, chèn dấu chấm/gạch dưới, teencode s3x/d4m, lặp ký tự) mà
// không cần admin liệt kê từng biến thể riêng.
// /tucam18 ds — liệt kê danh sách từ khoá 18+ hiện tại.
// /tucam18 xoa [tu_khoa] — xóa 1 từ khoá khỏi danh sách.
// Danh sách mặc định TRỐNG (env sạch tới khi admin tự cấu hình) — xem
// giải thích ở KEY_TU_KHOA_18_TUY_CHINH.
async function xuLyTuCam18(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const phan = message.text.trim().split(/\s+/);
  const hanhDongTho = (phan[1] || "").toLowerCase();

  if (!phan[1]) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        "⚠️ Dùng:\n" +
        "/tucam18 [tu_khoa] — thêm từ khóa 18+ mới (tự chịu được biến thể không dấu / chèn ký tự / teencode / lặp chữ)\n" +
        "/tucam18 ds — xem danh sách từ khóa 18+ hiện tại\n" +
        "/tucam18 xoa [tu_khoa] — xóa 1 từ khóa 18+ đã thêm",
    });
  }

  if (hanhDongTho === "ds") {
    const danhSach = await layTuKhoa18(env);
    const text =
      `🔞 TỪ KHOÁ 18+ ĐANG LỌC (${danhSach.length}):\n` +
      (danhSach.length ? danhSach.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(chưa cấu hình từ khoá nào — lớp lọc 18+ hiện KHÔNG chặn gì)");
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text });
  }

  if (hanhDongTho === "xoa") {
    const tuXoa = phan.slice(2).join(" ").trim();
    if (!tuXoa) {
      return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /tucam18 xoa [tu_khoa]" });
    }
    const danhSach = await layTuKhoa18(env);
    const idx = danhSach.findIndex((t) => t.toLowerCase() === tuXoa.toLowerCase());
    if (idx === -1) {
      return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `❌ Không tìm thấy "${tuXoa}" trong danh sách 18+.` });
    }
    danhSach.splice(idx, 1);
    await luuTuKhoa18(env, danhSach);
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `✅ Đã xóa từ khoá 18+: "${tuXoa}"` });
  }

  // Mặc định: THÊM MỚI — lấy nguyên phần còn lại tin nhắn sau /tucam18.
  const tuMoi = phan.slice(1).join(" ").trim();

  const danhSach = await layTuKhoa18(env);
  if (danhSach.some((t) => t.toLowerCase() === tuMoi.toLowerCase())) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `⚠️ Từ khoá "${tuMoi}" đã có trong danh sách 18+ rồi.` });
  }

  danhSach.push(tuMoi);
  await luuTuKhoa18(env, danhSach);

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text:
      `✅ Đã thêm từ khoá 18+: "${tuMoi}"\n` +
      "Tin nhắn (kể cả chữ trong ảnh) chứa cụm này — hoặc biến thể không dấu / chèn ký tự / teencode / lặp chữ của nó — sẽ tự động bị xoá.",
  });
}

// /taogifcode [so_coin hoặc min-max] [code] [so_luong_duoc_nhap] [loi_nhan] —
// tạo gift code mới, dùng chung 1 mã cho nhiều người, mỗi người chỉ nhập
// được 1 lần. so_coin có thể là số cố định ("5000") hoặc 1 khoảng
// ("4000-5000") — nếu là khoảng, mỗi lượt nhập sẽ được random 1 số coin
// ngẫu nhiên trong đó. loi_nhan (TÙY CHỌN) là dòng tiêu đề đầu tin thông
// báo, VD "🎁 GIFT CODE MỖI NGÀY!" — có thể chứa khoảng trắng/emoji, lấy
// nguyên phần còn lại của tin nhắn sau so_luong. Nếu không nhập, mặc định
// dùng "🎁 GIFT CODE NGẪU NHIÊN!" (xem xayDungTinGifcode).
async function xuLyTaoGifcode(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const vanBan = message.text.trim();
  // 3 tham số đầu không chứa khoảng trắng; tiếp theo có thể có 1 tham số
  // TÙY CHỌN dạng "veN" (VD "ve5") để tặng kèm N vé quay cho mỗi lượt nhập
  // mã — không bắt buộc, giữ tương thích ngược với cú pháp cũ. Phần còn
  // lại (nếu có) — kể cả khoảng trắng bên trong — được gom nguyên vẹn làm
  // loi_nhan.
  const khop = vanBan.match(/^\S+\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(ve\d+))?(?:\s+([\s\S]+))?$/i);
  if (!khop) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        "⚠️ Dùng: /taogifcode [so_coin hoặc min-max] [code] [so_luong_duoc_nhap] [veN (tuỳ chọn)] [loi_nhan]\n" +
        "VD số cố định: /taogifcode 5000 TET2026 100\n" +
        "VD khoảng random: /taogifcode 4000-5000 TET2026 100\n" +
        "VD kèm vé quay: /taogifcode 4000-5000 TET2026 100 ve5\n" +
        "VD kèm vé quay + lời nhắn riêng: /taogifcode 4000-5000 TET2026 100 ve5 🧧 GIFT CODE TẾT 2026!",
    });
  }

  const khoangCoin = phanTichKhoangCoin(khop[1]);
  const maGoc = khop[2];
  const soLuong = Number(khop[3]);
  const veQuayThuong = khop[4] ? Number(khop[4].slice(2)) : 0; // "ve5" → 5
  const loiNhan = khop[5] ? khop[5].trim() : null;

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
    veQuayThuong, // số vé quay tặng kèm mỗi lượt nhập mã (0 nếu không dùng tham số veN)
    soLuongToiDa: soLuong,
    soLuongDaDung: 0,
    taoLuc: Date.now(),
    taoBoi: String(message.from.id),
    loiNhan, // lưu lại để tiện tra cứu sau này (không bắt buộc dùng ở đâu khác)
  };
  await env.USERS.put(TIEN_TO_GIFCODE + ma, JSON.stringify(giftcodeMoi));

  const dongThuong =
    khoangCoin.min === khoangCoin.max
      ? `${khoangCoin.min.toLocaleString("vi-VN")} coin/lượt`
      : `${khoangCoin.min.toLocaleString("vi-VN")} - ${khoangCoin.max.toLocaleString("vi-VN")} coin/lượt (ngẫu nhiên)`;
  const dongVeQuayXacNhan = veQuayThuong > 0 ? `\n🎫 Vé quay/lượt: ${veQuayThuong.toLocaleString("vi-VN")}` : "";

  await telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `✅ Đã tạo gift code!\n\n🎁 Mã: \`${ma}\`\n🪙 Thưởng: ${dongThuong}${dongVeQuayXacNhan}\n👥 Số lượt tối đa: ${soLuong.toLocaleString("vi-VN")}\n\n📣 Đang gửi thông báo tới nhóm...`,
    parse_mode: "Markdown",
  });

  // Chỉ gửi thông báo vào NHÓM TRÒ CHUYỆN (cấu hình qua biến môi trường
  // NHOM_CHAT trên Worker) — KHÔNG gửi vào kênh thông báo nữa, và cũng
  // KHÔNG gửi riêng (DM) cho từng user như trước. Vì đây là nhóm (không
  // phải chat riêng với bot), nút web_app KHÔNG dùng được ở đây (Telegram
  // chỉ cho phép web_app trong chat riêng 1-1 với bot) nên dùng nút "url"
  // trỏ về chat riêng với bot, từ đó user tự bấm nút mở miniapp ở /start.
  const tinNhan = xayDungTinGifcode(giftcodeMoi, loiNhan);
  const linkBot = env.LINK_BOT || "https://t.me/vuacaytien_bot";

  const diaChiGui = [];
  if (env.NHOM_CHAT) diaChiGui.push({ ten: "🌐 Nhóm trò chuyện", chatId: env.NHOM_CHAT });

  if (diaChiGui.length === 0) {
    return telegramApi(env, "sendMessage", {
      chat_id: message.chat.id,
      text:
        "⚠️ Mã đã tạo thành công nhưng CHƯA gửi được thông báo — chưa cấu hình biến môi trường " +
        "NHOM_CHAT trên Worker (Dashboard > Settings > Variables and secrets). " +
        "Nhớ thêm bot làm admin của nhóm đó trước khi gửi.",
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

// /xoacode [code] — XÓA VĨNH VIỄN 1 gift code NGAY CẢ KHI CHƯA hết lượt
// nhập — khác /xoagiftcodedayluot (chỉ dọn mã đã hết lượt). Dùng khi cần
// vô hiệu hóa gấp 1 mã cụ thể (vd lỡ tạo sai số coin, mã bị lộ ra ngoài
// nhóm không mong muốn...). Sau khi xóa, endpoint /nhap-gifcode sẽ trả về
// lỗi "ma_khong_ton_tai" cho mọi lượt nhập tiếp theo với mã này.
async function xuLyXoaCode(env, message) {
  if (!(await laAdmin(env, message.from.id))) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "❌ Bạn không có quyền!" });
  }

  const phan = message.text.trim().split(/\s+/);
  if (phan.length < 2) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: "⚠️ Dùng: /xoacode [code]" });
  }

  const ma = phan[1].toUpperCase();
  const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
  if (!raw) {
    return telegramApi(env, "sendMessage", { chat_id: message.chat.id, text: `❌ Mã "${ma}" không tồn tại.` });
  }

  const gc = JSON.parse(raw);
  await env.USERS.delete(TIEN_TO_GIFCODE + ma);

  return telegramApi(env, "sendMessage", {
    chat_id: message.chat.id,
    text:
      `✅ Đã xóa gift code "${ma}" (đã dùng ${gc.soLuongDaDung}/${gc.soLuongToiDa} lượt).\n` +
      `🚫 Mã này sẽ KHÔNG còn hoạt động được nữa, kể cả khi chưa hết lượt nhập.`,
  });
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
      daDatLv2: false, // chỉ để HIỂN THỊ trạng thái trong tab Bạn bè — xem congBxhMoiBanNeuDuDieuKien(); KHÔNG ảnh hưởng thưởng 80 coin (đã cộng ngay bên dưới)
    });
    await congThuongMoiBanThanhCong(env, refUid); // +80 coin cho người mời — NHẬN NGAY, không cần điều kiện gì
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
        [{ text: "📢 Kênh thông báo", url: env.LINK_KENH_THONG_BAO || LINK_KENH_MAC_DINH }],
        [{ text: "🌐 Nhóm trò chuyện", url: env.LINK_NHOM_CHAT || LINK_NHOM_MAC_DINH }],
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
// 🚫 LỌC LINK LẠ + TỪ KHOÁ CẤM TRONG NHÓM — tự động XOÁ tin nhắn nếu khớp
// 1 trong 2 LỚP KIỂM TRA sau (dừng ngay khi có lớp nào khớp):
//   1) Chứa link KHÔNG thuộc hệ sinh thái Vua Cày Tiền (coLinkLaTrongTinNhan)
//   2) Chứa 1 trong các TỪ KHOÁ CẤM cố định, liên quan tới việc lôi kéo
//      xem bio (coTuCamTrongTinNhan — xem DANH_SACH_TU_KHOA_CAM)
//
// (Lớp thứ 3 trước đây dùng AI — Cloudflare Workers AI / Anthropic API —
// để bắt các trường hợp spammer diễn đạt khác đi đã bị GỠ BỎ HOÀN TOÀN.
// Không còn gọi env.AI hay ANTHROPIC_API_KEY ở đâu trong file này nữa.)
//
// Đây là chiêu spam phổ biến: đặt link quảng cáo app đối thủ ở phần BIO
// (tiểu sử) tài khoản Telegram, rồi nhắn kiểu "vào bio tôi xem" để né bộ
// lọc link trong tin nhắn thường.
//
// Trước khi xoá, tin được forward nguyên văn vào NHOM_LOG để admin xem lại
// nếu cần.
//
// MIỄN TRỪ: admin (theo layDanhSachAdmin) và tin gửi ẩn danh THAY MẶT
// NHÓM (tính năng "Gửi ẩn danh" dành cho quản trị viên) — để không tự
// khoá tay admin khi cần đăng link cần thiết (vd link nạp/rút, đối tác).
//
// LƯU Ý: bot cần được thêm làm ADMIN của nhóm kèm quyền "Xoá tin nhắn"
// (Delete messages) thì deleteMessage bên dưới mới có tác dụng.
// ==================================================

// Bổ sung thủ công các username Telegram (bot/nhóm/kênh) khác NGOÀI bot
// chính/nhóm chính/kênh chính vẫn muốn CHO PHÉP đăng trong nhóm (vd kênh
// phụ, đối tác chính thức...). So khớp KHÔNG phân biệt hoa thường.
const DANH_SACH_USERNAME_TG_DUOC_PHEP_THEM = [];

// Bổ sung thủ công các domain (ngoài t.me/telegram.me) được coi là AN
// TOÀN — vd nếu có trang landing/hỗ trợ riêng ở domain khác.
const DANH_SACH_DOMAIN_DUOC_PHEP_THEM = [];

// Lấy "username" (đoạn đầu tiên trong path) từ 1 link t.me/telegram.me —
// vd "https://t.me/vuacaytien_bot?start=x" → "vuacaytien_bot". Trả về
// null nếu link không hợp lệ hoặc không phải domain Telegram.
function tenNguoiDungTuLinkTelegram(link) {
  if (!link) return null;
  try {
    const u = new URL(link);
    if (!["t.me", "telegram.me"].includes(u.hostname.toLowerCase())) return null;
    const doan = u.pathname.split("/").filter(Boolean)[0];
    return doan ? doan.toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

// Danh sách username Telegram được coi là "thuộc app" — tự suy ra từ các
// biến môi trường LINK_BOT / LINK_NHOM_CHAT / LINK_KENH_THONG_BAO đang
// cấu hình (fallback về link mặc định nếu chưa cấu hình), gộp thêm
// DANH_SACH_USERNAME_TG_DUOC_PHEP_THEM.
function layDanhSachUsernameDuocPhep(env) {
  const raw = [
    tenNguoiDungTuLinkTelegram(env.LINK_BOT || "https://t.me/vuacaytien_bot"),
    tenNguoiDungTuLinkTelegram(env.LINK_NHOM_CHAT || LINK_NHOM_MAC_DINH),
    tenNguoiDungTuLinkTelegram(env.LINK_KENH_THONG_BAO || LINK_KENH_MAC_DINH),
    ...DANH_SACH_USERNAME_TG_DUOC_PHEP_THEM,
  ];
  return new Set(raw.filter(Boolean).map((s) => s.toLowerCase()));
}

// Danh sách domain (ngoài t.me/telegram.me, vốn được xét riêng theo
// username ở trên) được coi là AN TOÀN — gồm domain của LINK_MINIAPP (nếu
// deploy ở domain riêng) + DANH_SACH_DOMAIN_DUOC_PHEP_THEM.
function layDanhSachDomainDuocPhep(env) {
  const raw = ["t.me", "telegram.me", ...DANH_SACH_DOMAIN_DUOC_PHEP_THEM];
  if (env.LINK_MINIAPP) {
    try {
      raw.push(new URL(env.LINK_MINIAPP).hostname.toLowerCase());
    } catch (e) {
      // LINK_MINIAPP không phải 1 URL đầy đủ (vd thiếu scheme) — bỏ qua
    }
  }
  return new Set(raw.map((s) => s.toLowerCase()));
}

// Trích TOÀN BỘ URL xuất hiện trong 1 tin nhắn (text hoặc caption ảnh/
// video). Ưu tiên đọc từ entities Telegram trả sẵn (type "url" và
// "text_link" — bắt được cả link ẩn sau chữ như "bấm vào đây"); offset/
// length của entity tính theo UTF-16 code unit, KHỚP với cách JS String
// đánh chỉ số nên .slice() dùng thẳng được, không cần quy đổi gì thêm.
// Có thêm regex quét thô làm lưới an toàn thứ 2, phòng khi entities bị
// thiếu (hiếm khi xảy ra).
function trichCacLinkTrongTinNhan(message) {
  const vanBan = message.text || message.caption || "";
  const entities = message.entities || message.caption_entities || [];
  const cacLink = new Set();

  for (const en of entities) {
    if (en.type === "text_link" && en.url) {
      cacLink.add(en.url);
    } else if (en.type === "url") {
      cacLink.add(vanBan.slice(en.offset, en.offset + en.length));
    }
  }

  const regexUrl = /(https?:\/\/[^\s]+)|(\bt\.me\/[^\s]+)/gi;
  let khop;
  while ((khop = regexUrl.exec(vanBan)) !== null) {
    cacLink.add(khop[0].replace(/[)\]}.,!?;:'"]+$/, "")); // bỏ dấu câu dính đuôi (vd ".", "!" cuối câu)
  }

  return Array.from(cacLink);
}

// 1 link được coi là "thuộc hệ sinh thái app" nếu: (a) là link t.me/
// telegram.me VÀ username khớp bot/nhóm/kênh chính, HOẶC (b) domain nằm
// trong danh sách domain được phép. Link parse lỗi (dị dạng) → coi như AN
// TOÀN, không chặn oan vì lý do kỹ thuật.
function linkThuocHeSinhThai(link, danhSachUsername, danhSachDomain) {
  let u;
  try {
    u = new URL(link.startsWith("http") ? link : "https://" + link);
  } catch (e) {
    return true;
  }
  const host = u.hostname.toLowerCase();

  if (["t.me", "telegram.me"].includes(host)) {
    const doan = u.pathname.split("/").filter(Boolean)[0];
    return danhSachUsername.has(doan ? doan.toLowerCase() : "");
  }
  return danhSachDomain.has(host);
}

// true nếu tin nhắn chứa ÍT NHẤT 1 link không thuộc hệ sinh thái app.
function coLinkLaTrongTinNhan(env, message) {
  const cacLink = trichCacLinkTrongTinNhan(message);
  if (cacLink.length === 0) return false;

  const danhSachUsername = layDanhSachUsernameDuocPhep(env);
  const danhSachDomain = layDanhSachDomainDuocPhep(env);
  return cacLink.some((link) => !linkThuocHeSinhThai(link, danhSachUsername, danhSachDomain));
}

// ── LỌC THEO TỪ KHOÁ CẤM ──────────────────────────────────────────────
// Một số spammer né được bộ lọc link ở trên bằng cách KHÔNG dán link trực
// tiếp trong tin nhắn — mà đặt link ở BIO (tiểu sử) tài khoản Telegram của
// họ, rồi nhắn kiểu "vào bio/tiểu sử của tôi để xem", "check bio", "xem
// trang cá nhân"... để dụ nạn nhân tự bấm vào profile lấy link. Nên chặn
// thêm ở cấp độ TỪ nhắc tới bio/tiểu sử, không cần chờ có URL trong tin
// nhắn mới xoá được.
const DANH_SACH_TU_KHOA_CAM = ["bio", "tiểu sử", "trang cá nhân", "profile", "tieusu", "trong tsu", "tặng lộc", "nhóm share app", "BI🅾️", "ib", "tsu"]; // so khớp KHÔNG phân biệt hoa/thường, khớp NGUYÊN TỪ

// Danh sách từ khoá cấm TÙY CHỈNH — admin tự thêm/xóa qua lệnh Telegram
// /tucam (không cần deploy lại code). Lưu ở namespace ADMINS (giống
// KEY_BAO_TRI, KEY_DANH_SACH_ADMIN — cấu hình toàn hệ thống), GỘP THÊM vào
// DANH_SACH_TU_KHOA_CAM cố định ở trên khi lọc tin nhắn — không thay thế.
const KEY_TU_KHOA_CAM_TUY_CHINH = "tu-khoa-cam-tuy-chinh"; // JSON array các từ khóa cấm admin thêm qua /tucam

async function layTuKhoaCamTuyChinh(env) {
  const raw = await env.ADMINS.get(KEY_TU_KHOA_CAM_TUY_CHINH);
  return raw ? JSON.parse(raw) : [];
}

async function luuTuKhoaCamTuyChinh(env, danhSach) {
  await env.ADMINS.put(KEY_TU_KHOA_CAM_TUY_CHINH, JSON.stringify(danhSach));
}

// Gộp danh sách cố định (DANH_SACH_TU_KHOA_CAM) + tùy chỉnh (admin thêm qua
// /tucam) — dùng thay DANH_SACH_TU_KHOA_CAM trực tiếp ở mọi nơi cần lọc.
async function layToanBoTuKhoaCam(env) {
  const tuyChinh = await layTuKhoaCamTuyChinh(env);
  return [...DANH_SACH_TU_KHOA_CAM, ...tuyChinh];
}

// Escape ký tự đặc biệt regex trong 1 từ khoá trước khi dựng RegExp động.
function escapeRegex(chuoi) {
  return chuoi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// true nếu tin nhắn (text hoặc caption) chứa ÍT NHẤT 1 từ trong
// DANH_SACH_TU_KHOA_CAM, khớp NGUYÊN TỪ (không dính vào 1 từ khác — vd
// "app" không được khớp nhầm bên trong "happy", "sapp"...). Dùng
// \p{L}/\p{N} (chữ + số Unicode) làm ranh giới từ vì \b của JS không nhận
// diện đúng ký tự có dấu tiếng Việt.
async function coTuCamTrongTinNhan(env, message) {
  const vanBan = (message.text || message.caption || "").toLowerCase();
  if (!vanBan) return false;

  const danhSachTuCam = await layToanBoTuKhoaCam(env);
  return danhSachTuCam.some((tu) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(tu.toLowerCase())}(?![\\p{L}\\p{N}_])`, "u");
    return re.test(vanBan);
  });
}

// ── LỌC NỘI DUNG 18+ (CHUẨN HOÁ CHỐNG NÉ LỌC) ──────────────────────────
// Khác với DANH_SACH_TU_KHOA_CAM (khớp nguyên văn, không dấu-hoá), spammer/
// người dùng né bộ lọc nội dung nhạy cảm bằng rất nhiều biến thể tiếng Việt:
//   - Viết không dấu / gõ sai dấu: "sục" → "suc", "đụ" → "du"
//   - Chèn ký tự đặc biệt hoặc khoảng trắng xen giữa: "s.e.x", "s_e x", "đ.ụ"
//   - Teencode thay số cho chữ: "s3x", "d4m", "l0n" (0→o, 1→i, 3→e, 4→a, 5→s)
//   - Lặp ký tự để nhấn/né: "sexxx", "diiit"
// Hàm chuanHoaChongNeLoc() gộp cả 4 kiểu né lọc trên vào 1 bước chuẩn hoá
// DUY NHẤT trước khi so khớp, để 1 từ khoá trong danh sách bắt được TẤT CẢ
// biến thể cùng lúc mà không cần liệt kê từng biến thể riêng trong danh sách.
//
// Danh sách từ khoá 18+ KHÔNG được viết cứng trong code (khác với
// DANH_SACH_TU_KHOA_CAM) — admin tự quản lý qua lệnh Telegram /tucam18 (và
// tương đương trên web admin), lưu ở namespace ADMINS giống các danh sách
// cấu hình khác trong file. Lý do tách khỏi /tucam: nội dung 18+ nhạy cảm
// hơn nên cần a) danh sách trống mặc định (không cấu hình sẵn từ ngữ), b)
// action riêng khi khớp (xem duyetVi18) để dễ audit/điều chỉnh độc lập với
// bộ lọc bio/spam thông thường.
const KEY_TU_KHOA_18_TUY_CHINH = "tu-khoa-18-tuy-chinh"; // JSON array từ khoá 18+ admin thêm qua /tucam18

async function layTuKhoa18(env) {
  const raw = await env.ADMINS.get(KEY_TU_KHOA_18_TUY_CHINH);
  return raw ? JSON.parse(raw) : [];
}

async function luuTuKhoa18(env, danhSach) {
  await env.ADMINS.put(KEY_TU_KHOA_18_TUY_CHINH, JSON.stringify(danhSach));
}

// Bảng thay thế teencode số→chữ phổ biến khi né lọc tiếng Việt/tiếng Anh.
// Chỉ áp dụng SAU khi đã bỏ dấu tiếng Việt, nên không đụng tới số thật
// trong câu (vd giá tiền) vì hàm này chỉ dùng cho bản sao ĐÃ chuẩn hoá
// riêng để so khớp, không thay thế văn bản gốc hiển thị cho người dùng.
const BANG_TEENCODE_SO_SANG_CHU = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };

// Chuẩn hoá 1 chuỗi để so khớp từ khoá 18+, chịu được các kiểu né lọc nêu
// trên: bỏ dấu tiếng Việt → hạ thường → quy đổi teencode số→chữ → xoá mọi
// ký tự phân tách (khoảng trắng, dấu câu, ký tự đặc biệt) chèn xen giữa
// các chữ cái → rút gọn chuỗi ký tự lặp liên tiếp (>=3 lần) về còn 2 lần
// (đủ để diệt kiểu né "sexxx", "diiit" mà không làm hỏng từ có lặp tự
// nhiên như "xuất").
function chuanHoaChongNeLoc(chuoi) {
  let s = (chuoi || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // bỏ dấu thanh (dùng chung Unicode combining marks)
    .replace(/đ/g, "d");

  s = s.replace(/[0-9]/g, (c) => BANG_TEENCODE_SO_SANG_CHU[c] || c);
  s = s.replace(/[^a-z]/g, ""); // xoá khoảng trắng/dấu câu/emoji chèn xen giữa chữ cái
  s = s.replace(/(.)\1{2,}/g, "$1$1"); // rút gọn ký tự lặp >=3 về 2

  return s;
}

// So khớp 1 chuỗi văn bản (đã chuẩn hoá) với danh sách từ khoá 18+ (cũng
// chuẩn hoá) — hàm THUẦN, không tự đọc KV, dùng chung cho mọi nguồn văn bản
// (tin nhắn, caption, emoji/tên bộ sticker, tên file GIF, chữ OCR từ ảnh).
function khopTu18(vanBanGoc, danhSachTu18) {
  if (!vanBanGoc) return false;
  const vanBanChuan = chuanHoaChongNeLoc(vanBanGoc);
  if (!vanBanChuan) return false;
  return danhSachTu18.some((tu) => {
    const tuChuan = chuanHoaChongNeLoc(tu);
    return tuChuan.length > 0 && vanBanChuan.includes(tuChuan);
  });
}

// true nếu tin nhắn (text/caption) chứa ÍT NHẤT 1 từ khoá 18+ sau khi ĐÃ
// chuẩn hoá cả từ khoá lẫn văn bản qua chuanHoaChongNeLoc() — dùng khớp
// SUBSTRING (không khớp nguyên từ như coTuCamTrongTinNhan) vì sau bước xoá
// ký tự phân tách, ranh giới từ đã mất, nên so khớp theo cụm ký tự liền
// nhau là cách duy nhất còn bắt được biến thể chèn ký tự lạ.
async function coNoiDung18TrongTinNhan(env, message) {
  const vanBanGoc = message.text || message.caption || "";
  if (!vanBanGoc) return false;

  const danhSachTu18 = await layTuKhoa18(env);
  if (danhSachTu18.length === 0) return false; // chưa cấu hình từ khoá nào — bỏ qua, không chặn oan

  return khopTu18(vanBanGoc, danhSachTu18);
}

// OCR 1 file_id bất kỳ (ảnh, sticker tĩnh, thumbnail của GIF...) qua
// trichVanBanTuAnh() rồi so khớp với danh sách từ khoá 18+ — gộp lại thành
// 1 hàm dùng chung cho mọi loại media, thay vì lặp lại logic OCR+so khớp ở
// từng nơi gọi riêng lẻ.
async function coNoiDung18QuaOcrFileId(env, fileId) {
  const danhSachTu18 = await layTuKhoa18(env);
  if (danhSachTu18.length === 0) return false;

  const vanBanTrichDuoc = await trichVanBanTuAnh(env, fileId);
  if (!vanBanTrichDuoc) return false;

  return khopTu18(vanBanTrichDuoc, danhSachTu18);
}

// Bản dùng cho chữ trong ẢNH thường (photo) — dùng độ phân giải cao nhất
// Telegram trả về (size cuối cùng trong mảng) để OCR chính xác hơn.
async function anhCoNoiDung18TrongTinNhan(env, message) {
  if (!message.photo || !message.photo.length) return false;
  const anhDoPhanGiaiCaoNhat = message.photo[message.photo.length - 1];
  return coNoiDung18QuaOcrFileId(env, anhDoPhanGiaiCaoNhat.file_id);
}

// Bản dùng cho STICKER — 2 lớp kiểm tra:
//   1) Text: emoji gắn với sticker + tên bộ sticker (set_name) — soi được
//      cả sticker do người dùng tự đặt tên bộ theo từ 18+.
//   2) OCR: CHỈ áp dụng cho sticker TĨNH (định dạng webp, is_animated=false
//      và is_video=false) — vì đây là ảnh raster đọc được bằng model
//      vision. Sticker động (.tgs, Lottie) hoặc sticker video (.webm)
//      KHÔNG phải ảnh tĩnh nên bỏ qua bước OCR, tránh gọi Workers AI vô ích
//      (model vision không đọc được các định dạng này).
async function stickerCoNoiDung18TrongTinNhan(env, message) {
  const sticker = message.sticker;
  if (!sticker) return false;

  const danhSachTu18 = await layTuKhoa18(env);
  if (danhSachTu18.length === 0) return false;

  const moTaSticker = `${sticker.emoji || ""} ${sticker.set_name || ""}`.trim();
  if (khopTu18(moTaSticker, danhSachTu18)) return true;

  if (!sticker.is_animated && !sticker.is_video && sticker.file_id) {
    return coNoiDung18QuaOcrFileId(env, sticker.file_id);
  }
  return false;
}

// Bản dùng cho ANIMATION (GIF) — 2 lớp kiểm tra:
//   1) Text: tên file GIF gốc (file_name) — vd file quảng cáo lỡ giữ
//      nguyên tên file nhạy cảm lúc tải lên.
//   2) OCR: bản thân GIF là video ngắn nên KHÔNG OCR trực tiếp được, nhưng
//      Telegram luôn kèm 1 ẢNH THUMBNAIL (jpg) đại diện cho GIF đó — dùng
//      đúng ảnh này để đọc chữ, giống hệt cách xử lý ảnh thường.
async function animationCoNoiDung18TrongTinNhan(env, message) {
  const animation = message.animation;
  if (!animation) return false;

  const danhSachTu18 = await layTuKhoa18(env);
  if (danhSachTu18.length === 0) return false;

  if (khopTu18(animation.file_name || "", danhSachTu18)) return true;

  if (animation.thumbnail && animation.thumbnail.file_id) {
    return coNoiDung18QuaOcrFileId(env, animation.thumbnail.file_id);
  }
  return false;
}

// ── LỌC THEO CHỮ TRONG ẢNH ─────────────────────────────────────────────
// Spammer né được cả bộ lọc link lẫn bộ lọc từ khoá cấm bằng cách nhét chữ
// vào ẢNH thay vì gõ trực tiếp (banner quảng cáo, ảnh chụp màn hình có
// chữ...). Lớp này trích chữ hiển thị trong ảnh bằng Cloudflare Workers AI
// (model vision, đọc được cả tiếng Việt có dấu ở mức tương đối), rồi ÁP LẠI
// đúng logic khớp NGUYÊN TỪ đã dùng cho text (layToanBoTuKhoaCam +
// escapeRegex) lên phần chữ trích được — không có danh sách từ khoá riêng
// cho ảnh, dùng chung 1 nguồn với /tucam để admin chỉ cần quản lý 1 chỗ.
//
// YÊU CẦU: binding "AI" trong wrangler.toml, ví dụ:
//   [ai]
//   binding = "AI"
// Nếu chưa cấu hình (env.AI không tồn tại), hàm tự bỏ qua — KHÔNG chặn oan
// tin nhắn, giống cách các lớp lọc khác trong file xử lý khi thiếu cấu hình.
//
// LƯU Ý CHI PHÍ: mỗi ảnh gửi trong nhóm sẽ tốn 1 lượt gọi Workers AI (có
// giới hạn theo gói Cloudflare) — chỉ chạy cho tin có ảnh, không chạy cho
// mọi tin nhắn, và chỉ trong nhóm/siêu nhóm (không áp dụng chat riêng).
const MODEL_AI_DOC_ANH = "@cf/meta/llama-3.2-11b-vision-instruct";

// Lấy đường dẫn file thật trên server Telegram từ file_id, qua API getFile.
async function layDuongDanFileTelegram(env, fileId) {
  try {
    const kq = await telegramApi(env, "getFile", { file_id: fileId });
    if (!kq || !kq.ok || !kq.result || !kq.result.file_path) return null;
    return kq.result.file_path;
  } catch (e) {
    return null;
  }
}

// Tải nguyên byte ảnh từ server Telegram — dùng chung BOT_TOKEN mà
// telegramApi() đang dùng nội bộ. Nếu tên biến môi trường thực tế trong
// telegram.js khác "BOT_TOKEN", đổi lại cho khớp.
async function taiByteFileTelegram(env, filePath) {
  try {
    const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
}

// Trích văn bản hiển thị trong 1 ảnh (file_id) bằng Workers AI. Trả về
// chuỗi rỗng nếu không đọc được / chưa cấu hình / ảnh không có chữ —
// KHÔNG throw, để không làm hỏng cả luồng kiểm duyệt vì 1 lượt lỗi mạng.
async function trichVanBanTuAnh(env, fileId) {
  if (!env.AI) return ""; // chưa bật Workers AI binding — bỏ qua, không chặn oan
  try {
    const filePath = await layDuongDanFileTelegram(env, fileId);
    if (!filePath) return "";
    const bytes = await taiByteFileTelegram(env, filePath);
    if (!bytes || !bytes.length) return "";

    const ketQua = await env.AI.run(MODEL_AI_DOC_ANH, {
      image: Array.from(bytes),
      prompt:
        "Liệt kê CHÍNH XÁC toàn bộ chữ và số nhìn thấy được trong ảnh này, kể cả chữ nhỏ, chữ mờ, " +
        "chữ trong logo hay watermark. Giữ nguyên ngôn ngữ gốc, không dịch, không thêm giải thích. " +
        "Nếu ảnh không có chữ nào, trả lời đúng 1 từ: KHONGCOCHU.",
      max_tokens: 512,
    });

    const vanBan = (ketQua && (ketQua.response || ketQua.description)) || "";
    return /^\s*khongcochu\s*$/i.test(vanBan) ? "" : vanBan;
  } catch (e) {
    console.error("Lỗi trích văn bản từ ảnh (Workers AI):", e);
    return "";
  }
}

// true nếu ẢNH trong tin nhắn (nếu có) chứa chữ khớp NGUYÊN TỪ với 1 trong
// các từ khoá cấm (cố định + tùy chỉnh qua /tucam) — dùng chung hàm khớp từ
// với coTuCamTrongTinNhan() để không lệch logic giữa lọc text và lọc ảnh.
async function anhCoTuCamTrongTinNhan(env, message) {
  if (!message.photo || !message.photo.length) return false;

  // Telegram trả nhiều size cùng 1 ảnh, size cuối cùng là lớn nhất — đọc
  // chữ chính xác hơn ở ảnh độ phân giải cao.
  const anhDoPhanGiaiCaoNhat = message.photo[message.photo.length - 1];
  const vanBanTrichDuoc = await trichVanBanTuAnh(env, anhDoPhanGiaiCaoNhat.file_id);
  if (!vanBanTrichDuoc) return false;

  const vanBanChuan = vanBanTrichDuoc.toLowerCase();
  const danhSachTuCam = await layToanBoTuKhoaCam(env);
  return danhSachTuCam.some((tu) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(tu.toLowerCase())}(?![\\p{L}\\p{N}_])`, "u");
    return re.test(vanBanChuan);
  });
}

// Tin gửi "ẩn danh" THAY MẶT nhóm/kênh (tính năng dành cho quản trị viên)
// — Bot API trả sender_chat trùng với chat.id trong trường hợp này. Coi
// như admin, KHÔNG lọc, để không tự khoá tay quản trị viên nhóm.
function laGuiAnDanhBoiNhom(message) {
  return !!(message.sender_chat && message.chat && message.sender_chat.id === message.chat.id);
}

// Điều kiện tổng: CHỈ lọc trong nhóm/siêu nhóm (không áp dụng chat riêng
// với bot), bỏ qua admin và tin gửi ẩn danh thay mặt nhóm. Xoá nếu tin
// chứa link lạ, từ khoá cấm (bio/spam), HOẶC nội dung 18+ — lớp 18+ quét
// CẢ text/caption, ẢNH (OCR), STICKER (emoji + tên bộ, cộng OCR nếu là
// sticker tĩnh webp) và ANIMATION/GIF (tên file, cộng OCR ảnh thumbnail).
// Ghi chú giới hạn: sticker ĐỘNG (.tgs Lottie) và sticker VIDEO (.webm)
// không OCR được vì không phải ảnh raster; custom emoji Premium (icon do
// user tự upload, gắn qua entity "custom_emoji") cũng chưa được quét vì
// cần thêm 1 lượt gọi getCustomEmojiStickers/user mới lấy được file để
// OCR — có thể bổ sung sau nếu cần.
async function canXoaViLinkLa(env, message) {
  if (loaiChat(message) !== "👥 NHÓM") return false;
  if (laGuiAnDanhBoiNhom(message)) return false;
  const nguoiGuiId = message.from && message.from.id;
  if (nguoiGuiId && (await laAdmin(env, nguoiGuiId))) return false;

  if (coLinkLaTrongTinNhan(env, message)) return true;
  if (await coTuCamTrongTinNhan(env, message)) return true;
  if (await anhCoTuCamTrongTinNhan(env, message)) return true;
  if (await coNoiDung18TrongTinNhan(env, message)) return true; // text/caption
  if (await anhCoNoiDung18TrongTinNhan(env, message)) return true; // ảnh (OCR)
  if (await stickerCoNoiDung18TrongTinNhan(env, message)) return true; // sticker (emoji/tên bộ + OCR nếu tĩnh)
  if (await animationCoNoiDung18TrongTinNhan(env, message)) return true; // GIF (tên file + OCR thumbnail)

  return false;
}

// Lưu vết (forward nguyên văn) vào NHOM_LOG rồi xoá tin khỏi nhóm. Trả về
// true nếu ĐÃ xoá thành công — router dùng giá trị này để quyết định có
// cần ghiLogVaThongBao() bình thường nữa hay không (tránh log trùng lặp).
async function xuLyXoaTinNhanLinkLa(env, message) {
  try {
    await telegramApi(env, "sendMessage", {
      chat_id: env.NHOM_LOG,
      text: `🚫 Tự động xoá tin nhắn chứa link lạ, từ khoá cấm (text hoặc trong ảnh) trong nhóm "${message.chat.title || message.chat.id}"`,
    });
    await telegramApi(env, "forwardMessage", {
      chat_id: env.NHOM_LOG,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
  } catch (e) {
    console.error("Lỗi lưu vết tin nhắn link lạ trước khi xoá:", e);
  }

  try {
    const ketQua = await telegramApi(env, "deleteMessage", {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
    return !!(ketQua && ketQua.ok);
  } catch (e) {
    console.error("Lỗi xoá tin nhắn link lạ (bot có thể chưa là admin / thiếu quyền xoá tin):", e);
    return false;
  }
}

// ==================================================
// 🔀 Router lệnh + bắt tất cả tin nhắn còn lại
// ==================================================
async function xuLyUpdate(env, update) {
  if (update.callback_query) return; // không còn nút duyệt rút tiền qua Telegram — xử lý ở web admin

  const message = update.message;
  if (!message) return;

  // 🚫 Lọc link lạ — kiểm tra TRƯỚC khi xét lệnh, để chặn được cả trường
  // hợp link lạ bị nhét kèm vào chuỗi trông giống lệnh (vd "/x http://...").
  // Bọc try/catch riêng: nếu bước lọc lỗi vì lý do gì đó, KHÔNG để mất bản
  // ghi log bình thường của tin nhắn — rơi xuống dưới xử lý như cũ.
  try {
    if (await canXoaViLinkLa(env, message)) {
      const daXoa = await xuLyXoaTinNhanLinkLa(env, message);
      if (daXoa) return; // đã xoá + lưu vết riêng — khỏi cần log lại lần nữa
    }
  } catch (e) {
    console.error("Lỗi khi lọc link lạ, bỏ qua bước lọc cho tin nhắn này:", e);
  }

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
      case "/lammoibxh":
        return xuLyLamMoiBangXepHang(env, message);
      case "/checknv":
        return xuLyCheckNhiemVu(env, message);
      case "/id":
        return xuLyLayId(env, message);
      case "/dslenh":
        return xuLyDsLenh(env, message);
      case "/baotri":
        return xuLyBaoTri(env, message);
      case "/tucam":
        return xuLyTuCam(env, message);
      case "/tucam18":
        return xuLyTuCam18(env, message);
      case "/taogifcode":
        return xuLyTaoGifcode(env, message);
      case "/checkcode":
        return xuLyCheckCode(env, message);
      case "/checkcodesl":
        return xuLyCheckCodeSoLuong(env, message);
      case "/xoacode":
        return xuLyXoaCode(env, message);
      case "/gui":
        return xuLyGuiThongBao(env, message);
      case "/mute":
        return xuLyMute(env, message);
      case "/unmute":
        return xuLyUnmute(env, message);
      case "/ban":
        return xuLyBan(env, message);
      case "/unban":
        return xuLyUnban(env, message);
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

  // (ĐÃ BỎ cooldown giữa 2 lần vượt link — chỉ còn chặn bởi
  // LINK4M_GIOI_HAN_NGAY lượt/ngày ở trên.)

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
    ve_quay: nguoiDung ? nguoiDung.veQuay || 0 : 0,
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

  const soCoinCong = Number(env.THUONG_COIN_QUANG_CAO || 4500); // nếu đã đặt biến môi trường THUONG_COIN_QUANG_CAO trên Worker thì cần cập nhật giá trị đó luôn, vì nó được ưu tiên hơn số mặc định này
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_QUANG_CAO); // +8 XP đào/lượt xem quảng cáo
  await congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung); // chỉ tính vào BXH Mời Bạn nếu vừa đạt Lv2 (KHÔNG cộng thêm coin)
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);
  await tangBoDemToanCuc(env, KEY_TONG_LUOT_QC); // thống kê all-time (không hiển thị nữa nhưng vẫn giữ để không mất dữ liệu)
  await tangBoDemNgay(env, TIEN_TO_QC_NGAY_TK, homNay); // thống kê theo ngày cho /checknv (7 ngày gần nhất)

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
  // Nếu đã cấu hình ADSGRAM_SECRET_TOKEN (đặt cùng chuỗi này vào tham số
  // "secret" trong Reward URL trên partner.adsgram.ai), bắt buộc khớp
  // đúng token mới xử lý — đây là callback SERVER-TO-SERVER nên KHÔNG thể
  // kèm initData Telegram, secret token là lớp xác thực duy nhất khả thi.
  // Chưa cấu hình thì bỏ qua bước này (giữ hành vi cũ), chỉ còn giới hạn
  // ngày/cooldown làm lớp phòng vệ như trước.
  if (env.ADSGRAM_SECRET_TOKEN && !soSanhAnToan(url.searchParams.get("secret") || "", env.ADSGRAM_SECRET_TOKEN)) {
    return new Response("sai_secret", { status: 401 });
  }

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

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.veQuay = (nguoiDung.veQuay || 0) + 1; // Adsgram KHÔNG còn thưởng coin nữa — mỗi lượt xem hoàn thành CHỈ tặng đúng 1 vé quay
  await luuNguoiDung(env, uid, nguoiDung);
  await tangBoDemToanCuc(env, KEY_TONG_LUOT_ADSGRAM); // thống kê all-time (không hiển thị nữa nhưng vẫn giữ để không mất dữ liệu)
  await tangBoDemNgay(env, TIEN_TO_ADSGRAM_NGAY_TK, homNay); // thống kê theo ngày cho /checknv (7 ngày gần nhất)

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin || 0,
    so_lan_adsgram_da_xem: soLanMoi,
    adsgram_gioi_han_ngay: ADSGRAM_GIOI_HAN_NGAY,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
    ve_quay: nguoiDung.veQuay || 0,
    ve_quay_moi_nhan: true, // Adsgram luôn tặng +1 vé quay mỗi lượt hoàn thành, không cần điều kiện gộp lượt như Link4M
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
  const nguoiDung = await layNguoiDung(env, uid);

  return Response.json({
    thanh_cong: true,
    chuoi_hien_tai: dd.chuoi_hien_tai || 0,
    da_diem_danh_hom_nay: dd.ngay_cuoi === homNay,
    thuong: THUONG_DIEM_DANH,
    bao_ve_chuoi_con_lai: nguoiDung ? nguoiDung.baoVeChuoiSoLuong || 0 : 0,
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
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };

  let chuoiMoi;
  let daDungBaoVeChuoi = false;
  if (dd.ngay_cuoi === homQua) {
    chuoiMoi = (dd.chuoi_hien_tai || 0) + 1;
  } else if (dd.ngay_cuoi && (nguoiDung.baoVeChuoiSoLuong || 0) > 0) {
    // Đứt chuỗi (bỏ lỡ ít nhất 1 ngày) nhưng còn lượt bảo vệ — tiêu 1 lượt,
    // giữ nguyên chuỗi thay vì reset về 1.
    nguoiDung.baoVeChuoiSoLuong -= 1;
    daDungBaoVeChuoi = true;
    chuoiMoi = (dd.chuoi_hien_tai || 0) + 1;
  } else {
    chuoiMoi = 1;
  }

  const viTriThuong = (chuoiMoi - 1) % THUONG_DIEM_DANH.length;
  const soCoinCong = THUONG_DIEM_DANH[viTriThuong];

  await luuDiemDanh(env, uid, { chuoi_hien_tai: chuoiMoi, ngay_cuoi: homNay });

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
    da_dung_bao_ve_chuoi: daDungBaoVeChuoi,
    bao_ve_chuoi_con_lai: nguoiDung.baoVeChuoiSoLuong || 0,
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

// ==================================================
// 🛒 CỬA HÀNG — /shop-thong-tin (đọc trạng thái) và /shop-mua (mua vật phẩm)
// ==================================================
async function xuLyShopThongTin(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0 };

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin || 0,
    vat_pham: Object.values(SHOP_VAT_PHAM),
    boost_dao: thongTinBoostDaoDeTra(nguoiDung),
    bao_ve_chuoi_so_luong: nguoiDung.baoVeChuoiSoLuong || 0,
    bao_ve_chuoi_toi_da: BAO_VE_CHUOI_TOI_DA,
  });
}

async function xuLyShopMua(env, url) {
  const uid = url.searchParams.get("uid");
  const ma = url.searchParams.get("ma");
  if (!uid || !ma) return Response.json({ thanh_cong: false, loi: "thieu_tham_so" }, { status: 400 });

  const vatPham = SHOP_VAT_PHAM[ma];
  if (!vatPham) return Response.json({ thanh_cong: false, loi: "vat_pham_khong_ton_tai" });

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0 };
  const coinHienCo = nguoiDung.coin || 0;

  if (ma === "boost_dao_x2" && nguoiDung.boostDao && nguoiDung.boostDao.hetHanLuc > Date.now()) {
    return Response.json({ thanh_cong: false, loi: "dang_co_hieu_luc" });
  }
  if (ma === "bao_ve_chuoi" && (nguoiDung.baoVeChuoiSoLuong || 0) >= BAO_VE_CHUOI_TOI_DA) {
    return Response.json({ thanh_cong: false, loi: "da_dat_toi_da" });
  }
  if (coinHienCo < vatPham.gia) {
    return Response.json({ thanh_cong: false, loi: "khong_du_coin" });
  }

  nguoiDung.coin = coinHienCo - vatPham.gia;

  if (ma === "boost_dao_x2") {
    nguoiDung.boostDao = { hetHanLuc: Date.now() + BOOST_DAO_THOI_GIAN_MS, heSo: BOOST_DAO_HE_SO };
  } else if (ma === "bao_ve_chuoi") {
    nguoiDung.baoVeChuoiSoLuong = (nguoiDung.baoVeChuoiSoLuong || 0) + 1;
  }

  await luuNguoiDung(env, uid, nguoiDung);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    ma,
    boost_dao: thongTinBoostDaoDeTra(nguoiDung),
    bao_ve_chuoi_so_luong: nguoiDung.baoVeChuoiSoLuong || 0,
  });
}

// ==================================================
// 💼 TAB "LÀM THÊM" — gộp thông tin cho cả 4 ô: (1) nút điều hướng sang
// Nhiệm vụ chỉ cần link tĩnh nên không cần API riêng, (2) vòng quay may
// mắn (số vé quay + cấu hình phần thưởng), (3) trạng thái "Nhiệm vụ thêm —
// Vượt link" (đã tách khỏi tab Nhiệm vụ), (4) trạng thái Shop (boost đào,
// bảo vệ chuỗi). Gộp vào 1 endpoint để tab mở lên chỉ cần 1 lượt gọi.
// ==================================================
async function xuLyLamThemThongTin(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0 };

  const soLanLink4mDaXong = Number((await env.USERS.get(TIEN_TO_LINK4M_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const link4mLanCuoi = Number((await env.USERS.get(TIEN_TO_LINK4M_LAN_CUOI + uid)) || 0);
  const lichSuQuay = await layLichSuQuay(env, uid);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin || 0,
    ve_quay: nguoiDung.veQuay || 0,
    danh_sach_phan_thuong: CAU_HINH_VONG_QUAY,
    lich_su_quay: lichSuQuay,
    // Trạng thái "Nhiệm vụ thêm — Vượt link" (Link4M) — để ô 3 hiển thị
    // đúng số lượt còn lại / cooldown ngay khi vừa mở tab, không cần chờ
    // vòng lặp poll 45-60s sau đó.
    so_lan_link4m_da_xong: soLanLink4mDaXong,
    link4m_gioi_han_ngay: LINK4M_GIOI_HAN_NGAY,
    link4m_lan_cuoi: link4mLanCuoi,
    link4m_cho_toi_thieu_giay: LINK4M_CHO_TOI_THIEU_MS / 1000,
    // Trạng thái Shop (ô 4)
    vat_pham: Object.values(SHOP_VAT_PHAM),
    boost_dao: thongTinBoostDaoDeTra(nguoiDung),
    bao_ve_chuoi_so_luong: nguoiDung.baoVeChuoiSoLuong || 0,
    bao_ve_chuoi_toi_da: BAO_VE_CHUOI_TOI_DA,
  });
}

// Lịch sử quay — mảng { chi_so, coin, nhan, luc }, mới nhất lên đầu, tối đa
// SO_LUOT_LICH_SU_QUAY_LUU bản ghi/user. Dùng cho khối "Lịch sử quay" ngay
// dưới vòng quay ở tab Làm thêm.
async function layLichSuQuay(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_LICH_SU_QUAY + uid);
  return raw ? JSON.parse(raw) : [];
}

async function themLichSuQuay(env, uid, banGhi) {
  const danhSach = await layLichSuQuay(env, uid);
  danhSach.unshift(banGhi);
  await env.USERS.put(TIEN_TO_LICH_SU_QUAY + uid, JSON.stringify(danhSach.slice(0, SO_LUOT_LICH_SU_QUAY_LUU)));
  return danhSach.slice(0, SO_LUOT_LICH_SU_QUAY_LUU);
}

// Quay 1 lượt vòng quay may mắn — tiêu 1 vé quay (nguoiDung.veQuay), random
// có trọng số 1 ô thưởng trong CAU_HINH_VONG_QUAY, cộng thẳng coin vào ví.
// Trả về chi_so_trung để frontend animate bánh xe dừng đúng ô đã trúng, và
// lich_su_quay (đã cập nhật bản ghi mới nhất) để frontend hiển thị ngay,
// không cần gọi thêm request nào khác.
async function xuLyQuayThuong(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = await layNguoiDung(env, uid);
  if (!nguoiDung) return Response.json({ thanh_cong: false, loi: "khong_tim_thay_nguoi_dung" });

  const veHienCo = nguoiDung.veQuay || 0;
  if (veHienCo <= 0) {
    return Response.json({ thanh_cong: false, loi: "khong_du_ve_quay", ve_quay: veHienCo });
  }

  const chiSoTrung = quayNgauNhienChiSo(CAU_HINH_VONG_QUAY);
  const phanThuong = CAU_HINH_VONG_QUAY[chiSoTrung];

  nguoiDung.veQuay = veHienCo - 1;
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + phanThuong.coin;
  congCoin(nguoiDung, phanThuong.coin);
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, phanThuong.coin);

  const lichSuMoi = await themLichSuQuay(env, uid, {
    chi_so: chiSoTrung,
    coin: phanThuong.coin,
    nhan: phanThuong.nhan || null,
    luc: Date.now(),
  });

  return Response.json({
    thanh_cong: true,
    chi_so_trung: chiSoTrung,
    coin_cong: phanThuong.coin,
    nhan_trung: phanThuong.nhan || null,
    coin: nguoiDung.coin,
    ve_quay: nguoiDung.veQuay,
    lich_su_quay: lichSuMoi,
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

// ==================================================
// 🔗 NHIỆM VỤ VƯỢT LINK TAPLAYMA — SONG SONG với Link4M ở trên, dùng
// tiền tố KV riêng (nhiemvu-tp: / nhiemvu-tp-hientai:) và bộ đếm/giới hạn
// riêng (TAPLAYMA_GIOI_HAN_NGAY = 4 lượt/ngày, thưởng ngẫu nhiên
// TAPLAYMA_COIN_MIN-TAPLAYMA_COIN_MAX/lượt), hoàn thành ĐỦ 4 lượt trong
// ngày mới được tặng TAPLAYMA_VE_QUAY_THUONG (4) vé quay — khác Link4M vốn
// chỉ có 1 lượt/ngày và tặng 1 vé ngay khi hoàn thành. Logic đường đi
// giống hệt các hàm Link4M ở trên (đặt
// tên "TP" cho gọn), CHỈ khác đúng phần cấu hình + gọi API taplayma.com.
// ==================================================
const TIEN_TO_NHIEM_VU_TP = "nhiemvu-tp:";
const TIEN_TO_NHIEM_VU_TP_HIEN_TAI = "nhiemvu-tp-hientai:"; // con trỏ nhiệm vụ Taplayma đang chờ, để khôi phục khi mở lại app

async function taoNhiemVuTPMoi(env, uid) {
  for (let lanThu = 0; lanThu < 5; lanThu++) {
    const ma = sinhMaNgauNhien();
    const key = TIEN_TO_NHIEM_VU_TP + ma;
    const daTonTai = await env.USERS.get(key);
    if (daTonTai) continue; // đụng mã hiếm khi xảy ra, thử lại

    await env.USERS.put(key, JSON.stringify({ uid: String(uid), daDung: false, taoLuc: Date.now() }));
    return ma;
  }
  throw new Error("khong_sinh_duoc_ma");
}

async function layNhiemVuTPHienTai(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_TP_HIEN_TAI + uid);
  return raw ? JSON.parse(raw) : null;
}

async function luuNhiemVuTPHienTai(env, uid, duLieu) {
  await env.USERS.put(TIEN_TO_NHIEM_VU_TP_HIEN_TAI + uid, JSON.stringify(duLieu));
}

async function xoaNhiemVuTPHienTai(env, uid) {
  await env.USERS.delete(TIEN_TO_NHIEM_VU_TP_HIEN_TAI + uid);
}

async function xuLyTaoNhiemVuTP(env, url, goc) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chặn sớm nếu hôm nay đã dùng hết lượt rồi (tối đa TAPLAYMA_GIOI_HAN_NGAY
  // lần/ngày) — đỡ tốn 1 lượt gọi Taplayma vô ích
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_TAPLAYMA_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= TAPLAYMA_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_hom_nay" });
  }

  // Còn nhiệm vụ đang chờ, chưa hoàn thành, chưa hết hạn → trả lại ĐÚNG
  // link cũ, không tạo mới (giống cơ chế của Link4M).
  const dangCho = await layNhiemVuTPHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ thanh_cong: true, link: dangCho.link });
  }

  let ma;
  try {
    ma = await taoNhiemVuTPMoi(env, uid);
  } catch {
    return Response.json({ thanh_cong: false, loi: "khong_sinh_duoc_ma" }, { status: 500 });
  }

  const trangDich = `${goc}/nvtp/${ma}`;
  const apiUrl = `https://api.taplayma.com/api?token=${env.TAPLAYMA_API_TOKEN}&url=${encodeURIComponent(trangDich)}`;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (data.status === "success" && data.shortenedUrl) {
      await luuNhiemVuTPHienTai(env, uid, { ma, link: data.shortenedUrl, taoLuc: Date.now(), ngay: homNay });
      return Response.json({ thanh_cong: true, link: data.shortenedUrl });
    }
    return Response.json({ thanh_cong: false, loi: data.message || "loi_khong_ro" });
  } catch (e) {
    return Response.json({ thanh_cong: false, loi: String(e) }, { status: 500 });
  }
}

// Trạng thái hiện tại của nhiệm vụ Taplayma — frontend gọi lúc mở app để
// khôi phục link cũ, biết đã hoàn thành hôm nay chưa, đã vượt bao nhiêu
// lượt hôm nay, và hiện số dư (song song xuLyNhiemVuHienTai của Link4M).
async function xuLyNhiemVuHienTaiTP(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const nguoiDung = await layNguoiDung(env, uid);
  const coin = nguoiDung ? nguoiDung.coin || 0 : 0;

  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_TAPLAYMA_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const lanCuoi = Number((await env.USERS.get(TIEN_TO_TAPLAYMA_LAN_CUOI + uid)) || 0);

  const trangThaiChung = {
    coin,
    ve_quay: nguoiDung ? nguoiDung.veQuay || 0 : 0,
    so_lan_taplayma_da_xong: soLanDaXong,
    taplayma_gioi_han_ngay: TAPLAYMA_GIOI_HAN_NGAY,
    taplayma_lan_cuoi: lanCuoi,
    taplayma_cho_toi_thieu_giay: TAPLAYMA_CHO_TOI_THIEU_MS / 1000,
  };

  if (soLanDaXong >= TAPLAYMA_GIOI_HAN_NGAY) {
    return Response.json({ trang_thai: "da_hoan_thanh", ...trangThaiChung });
  }

  const dangCho = await layNhiemVuTPHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ trang_thai: "dang_cho", link: dangCho.link, ...trangThaiChung });
  }

  return Response.json({ trang_thai: "chua_co", ...trangThaiChung });
}

async function xuLyXacNhanNhiemVuTP(env, url) {
  const uid = url.searchParams.get("uid");
  const ma = url.searchParams.get("ma");
  if (!uid || !ma) return Response.json({ hoan_thanh: false, loi: "thieu_tham_so" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chốt chặn thật — dù có lách qua bước tạo link thế nào cũng dừng ở đây
  const keySoLan = TIEN_TO_TAPLAYMA_SO_LAN_NGAY + uid + ":" + homNay;
  const soLanDaXong = Number((await env.USERS.get(keySoLan)) || 0);
  if (soLanDaXong >= TAPLAYMA_GIOI_HAN_NGAY) {
    return Response.json({ hoan_thanh: false, loi: "da_vuot_hom_nay" });
  }

  const key = TIEN_TO_NHIEM_VU_TP + ma;
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
  await env.USERS.put(TIEN_TO_TAPLAYMA_LAN_CUOI + uid, String(Date.now()));
  await xoaNhiemVuTPHienTai(env, uid); // dọn con trỏ, nhiệm vụ này xong rồi

  // Cộng thưởng coin — ngẫu nhiên trong khoảng [TAPLAYMA_COIN_MIN, TAPLAYMA_COIN_MAX]
  const soCoinCong = ngauNhienCoinTrongKhoang(TAPLAYMA_COIN_MIN, TAPLAYMA_COIN_MAX);
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_VUOT_LINK); // XP đào/lượt vượt link, giống Link4M

  // 🎒 Chỉ tặng vé quay khi hoàn thành ĐỦ TAPLAYMA_GIOI_HAN_NGAY (4) lượt
  // trong ngày — KHÁC Link4M (chỉ 1 lượt/ngày, tặng ngay 1 vé), vì
  // Taplayma đã cấu hình thưởng thẳng 1 cụm 4 vé cho cả ngày, tránh cộng
  // dồn quá nhiều vé.
  let veQuayMoiNhan = false;
  if (soLanMoi >= TAPLAYMA_GIOI_HAN_NGAY) {
    nguoiDung.veQuay = (nguoiDung.veQuay || 0) + TAPLAYMA_VE_QUAY_THUONG;
    veQuayMoiNhan = true;
  }

  await congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung); // chỉ tính vào BXH Mời Bạn nếu vừa đạt Lv2 (KHÔNG cộng thêm coin)
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);
  await tangBoDemToanCuc(env, KEY_TONG_LUOT_TAPLAYMA); // thống kê all-time
  await tangBoDemNgay(env, TIEN_TO_TAPLAYMA_NGAY_TK, homNay); // thống kê theo ngày cho /checknv (7 ngày gần nhất)

  return Response.json({
    hoan_thanh: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_taplayma_da_xong: soLanMoi,
    taplayma_gioi_han_ngay: TAPLAYMA_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: TAPLAYMA_CHO_TOI_THIEU_MS / 1000,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
    ve_quay: nguoiDung.veQuay || 0,
    ve_quay_moi_nhan: veQuayMoiNhan,
  });
}

// Reset mã Taplayma — hủy nhiệm vụ đang chờ (CHƯA hoàn thành) để tạo lại
// link mới, dùng khi lỡ mất mã/đóng nhầm trang đích. Không cho reset nếu
// đã xong hôm nay rồi, tránh lách giới hạn ngày (song song xuLyResetNhiemVu
// của Link4M).
async function xuLyResetNhiemVuTP(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_TAPLAYMA_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= TAPLAYMA_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_hoan_thanh_khong_the_reset" });
  }

  const dangCho = await layNhiemVuTPHienTai(env, uid);
  if (!dangCho || dangCho.ngay !== homNay) {
    return Response.json({ thanh_cong: false, loi: "khong_co_gi_de_reset" });
  }

  await xoaNhiemVuTPHienTai(env, uid);
  return Response.json({ thanh_cong: true });
}

// ==================================================
// 🔗 NHIỆM VỤ VƯỢT LINK BBMKTS — SONG SONG với Link4M và Taplayma ở trên,
// dùng tiền tố KV riêng (nhiemvu-bb: / nhiemvu-bb-hientai:) và bộ đếm/giới
// hạn riêng (BBMKTS_GIOI_HAN_NGAY = 1 lượt/ngày, thưởng CỐ ĐỊNH
// BBMKTS_COIN_THUONG/lượt, tặng luôn 1 vé quay mỗi lần hoàn thành) — cùng
// cơ chế với Link4M (KHÁC Taplayma vốn phải gộp đủ nhiều lượt trong ngày
// mới được vé). Logic đường đi giống hệt các hàm Link4M/Taplayma ở trên
// (đặt tên "BB" cho gọn), CHỈ khác đúng phần cấu hình + gọi API bbmkts.com
// (endpoint /dapi, token lấy ở trang "Mã API" trên https://bbmkts.com/admin).
// ==================================================
const TIEN_TO_NHIEM_VU_BB = "nhiemvu-bb:";
const TIEN_TO_NHIEM_VU_BB_HIEN_TAI = "nhiemvu-bb-hientai:"; // con trỏ nhiệm vụ bbmkts đang chờ, để khôi phục khi mở lại app
const TIEN_TO_BBMKTS_SO_LAN_NGAY = "bbmkts-so-lan-ngay:"; // số lần hoàn thành nhiệm vụ bbmkts hôm nay
const BBMKTS_GIOI_HAN_NGAY = 1; // 1 lần/ngày — mỗi lần hoàn thành tặng luôn 1 vé quay (giống Link4M)
const TIEN_TO_BBMKTS_LAN_CUOI = "bbmkts-lan-cuoi:"; // mốc thời gian hoàn thành gần nhất — dự phòng, không dùng để chặn cooldown
const BBMKTS_CHO_TOI_THIEU_MS = 0; // không cooldown giữa 2 lần vượt — chỉ giới hạn theo BBMKTS_GIOI_HAN_NGAY lượt/ngày
const BBMKTS_COIN_THUONG = 3500; // mỗi lượt hoàn thành thưởng cố định 3500 coin

// ==================================================
// 🔗 NHIỆM VỤ VƯỢT LINK LAYMA.NET — SONG SONG với Link4M/Taplayma/bbmkts,
// dùng tiền tố KV riêng (nhiemvu-lm: / nhiemvu-lm-hientai:) và bộ đếm/giới
// hạn riêng (LAYMA_GIOI_HAN_NGAY = 2 lượt/ngày, thưởng CỐ ĐỊNH
// LAYMA_COIN_THUONG/lượt) — CHỈ tặng vé quay khi hoàn thành ĐỦ
// LAYMA_GIOI_HAN_NGAY (2) lượt trong ngày (giống cơ chế Taplayma, khác
// Link4M/bbmkts vốn tặng vé ngay mỗi lượt). API: quanly.layma.net /
// api.layma.net (endpoint /api/admin/shortlink/quicklink, token lấy ở
// trang quản lý riêng — biến môi trường LAYMA_API_TOKEN).
// ==================================================
const TIEN_TO_NHIEM_VU_LM = "nhiemvu-lm:";
const TIEN_TO_NHIEM_VU_LM_HIEN_TAI = "nhiemvu-lm-hientai:"; // con trỏ nhiệm vụ layma đang chờ, để khôi phục khi mở lại app
const TIEN_TO_LAYMA_SO_LAN_NGAY = "layma-so-lan-ngay:"; // số lần hoàn thành nhiệm vụ layma hôm nay
const LAYMA_GIOI_HAN_NGAY = 2; // 2 lần/ngày
const TIEN_TO_LAYMA_LAN_CUOI = "layma-lan-cuoi:"; // mốc thời gian hoàn thành gần nhất — dự phòng, không dùng để chặn cooldown
const LAYMA_CHO_TOI_THIEU_MS = 0; // không cooldown giữa 2 lần vượt — chỉ giới hạn theo LAYMA_GIOI_HAN_NGAY lượt/ngày
const LAYMA_COIN_THUONG = 2000; // mỗi lượt hoàn thành thưởng cố định 2000 coin
const LAYMA_VE_QUAY_THUONG = 2; // tặng khi hoàn thành ĐỦ LAYMA_GIOI_HAN_NGAY (2) lượt trong ngày

async function taoNhiemVuBBMoi(env, uid) {
  for (let lanThu = 0; lanThu < 5; lanThu++) {
    const ma = sinhMaNgauNhien();
    const key = TIEN_TO_NHIEM_VU_BB + ma;
    const daTonTai = await env.USERS.get(key);
    if (daTonTai) continue; // đụng mã hiếm khi xảy ra, thử lại

    await env.USERS.put(key, JSON.stringify({ uid: String(uid), daDung: false, taoLuc: Date.now() }));
    return ma;
  }
  throw new Error("khong_sinh_duoc_ma");
}

async function layNhiemVuBBHienTai(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_BB_HIEN_TAI + uid);
  return raw ? JSON.parse(raw) : null;
}

async function luuNhiemVuBBHienTai(env, uid, duLieu) {
  await env.USERS.put(TIEN_TO_NHIEM_VU_BB_HIEN_TAI + uid, JSON.stringify(duLieu));
}

async function xoaNhiemVuBBHienTai(env, uid) {
  await env.USERS.delete(TIEN_TO_NHIEM_VU_BB_HIEN_TAI + uid);
}

async function xuLyTaoNhiemVuBB(env, url, goc) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chặn sớm nếu hôm nay đã dùng hết lượt rồi (tối đa BBMKTS_GIOI_HAN_NGAY
  // lần/ngày) — đỡ tốn 1 lượt gọi bbmkts vô ích
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_BBMKTS_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= BBMKTS_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_hom_nay" });
  }

  // Còn nhiệm vụ đang chờ, chưa hoàn thành, chưa hết hạn → trả lại ĐÚNG
  // link cũ, không tạo mới (giống cơ chế của Link4M/Taplayma).
  const dangCho = await layNhiemVuBBHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ thanh_cong: true, link: dangCho.link });
  }

  let ma;
  try {
    ma = await taoNhiemVuBBMoi(env, uid);
  } catch {
    return Response.json({ thanh_cong: false, loi: "khong_sinh_duoc_ma" }, { status: 500 });
  }

  const trangDich = `${goc}/nvbb/${ma}`;
  const apiUrl = `https://bbmkts.com/dapi?token=${env.BBMKTS_API_TOKEN}&longurl=${encodeURIComponent(trangDich)}`;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (data.status === "success" && data.bbmktsUrl) {
      await luuNhiemVuBBHienTai(env, uid, { ma, link: data.bbmktsUrl, taoLuc: Date.now(), ngay: homNay });
      return Response.json({ thanh_cong: true, link: data.bbmktsUrl });
    }
    return Response.json({ thanh_cong: false, loi: data.message || "loi_khong_ro" });
  } catch (e) {
    return Response.json({ thanh_cong: false, loi: String(e) }, { status: 500 });
  }
}

// Trạng thái hiện tại của nhiệm vụ bbmkts — frontend gọi lúc mở app để
// khôi phục link cũ, biết đã hoàn thành hôm nay chưa, và hiện số dư (song
// song xuLyNhiemVuHienTai của Link4M / xuLyNhiemVuHienTaiTP của Taplayma).
async function xuLyNhiemVuHienTaiBB(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const nguoiDung = await layNguoiDung(env, uid);
  const coin = nguoiDung ? nguoiDung.coin || 0 : 0;

  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_BBMKTS_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const lanCuoi = Number((await env.USERS.get(TIEN_TO_BBMKTS_LAN_CUOI + uid)) || 0);

  const trangThaiChung = {
    coin,
    ve_quay: nguoiDung ? nguoiDung.veQuay || 0 : 0,
    so_lan_bbmkts_da_xong: soLanDaXong,
    bbmkts_gioi_han_ngay: BBMKTS_GIOI_HAN_NGAY,
    bbmkts_lan_cuoi: lanCuoi,
    bbmkts_cho_toi_thieu_giay: BBMKTS_CHO_TOI_THIEU_MS / 1000,
  };

  if (soLanDaXong >= BBMKTS_GIOI_HAN_NGAY) {
    return Response.json({ trang_thai: "da_hoan_thanh", ...trangThaiChung });
  }

  const dangCho = await layNhiemVuBBHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ trang_thai: "dang_cho", link: dangCho.link, ...trangThaiChung });
  }

  return Response.json({ trang_thai: "chua_co", ...trangThaiChung });
}

async function xuLyXacNhanNhiemVuBB(env, url) {
  const uid = url.searchParams.get("uid");
  const ma = url.searchParams.get("ma");
  if (!uid || !ma) return Response.json({ hoan_thanh: false, loi: "thieu_tham_so" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chốt chặn thật — dù có lách qua bước tạo link thế nào cũng dừng ở đây
  const keySoLan = TIEN_TO_BBMKTS_SO_LAN_NGAY + uid + ":" + homNay;
  const soLanDaXong = Number((await env.USERS.get(keySoLan)) || 0);
  if (soLanDaXong >= BBMKTS_GIOI_HAN_NGAY) {
    return Response.json({ hoan_thanh: false, loi: "da_vuot_hom_nay" });
  }

  const key = TIEN_TO_NHIEM_VU_BB + ma;
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
  await env.USERS.put(TIEN_TO_BBMKTS_LAN_CUOI + uid, String(Date.now()));
  await xoaNhiemVuBBHienTai(env, uid); // dọn con trỏ, nhiệm vụ này xong rồi

  // Cộng thưởng coin — CỐ ĐỊNH BBMKTS_COIN_THUONG (giống Link4M, khác
  // Taplayma vốn random trong khoảng)
  const soCoinCong = BBMKTS_COIN_THUONG;
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_VUOT_LINK); // XP đào/lượt vượt link, giống Link4M/Taplayma

  // 🎒 Mỗi lần hoàn thành (BBMKTS_GIOI_HAN_NGAY = 1, khớp Link4M) tặng
  // ngay 1 vé quay — KHÁC Taplayma (phải gộp đủ nhiều lượt mới được vé).
  nguoiDung.veQuay = (nguoiDung.veQuay || 0) + 1;
  const veQuayMoiNhan = true;

  await congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung); // chỉ tính vào BXH Mời Bạn nếu vừa đạt Lv2 (KHÔNG cộng thêm coin)
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);
  await tangBoDemToanCuc(env, KEY_TONG_LUOT_BBMKTS); // thống kê all-time
  await tangBoDemNgay(env, TIEN_TO_BBMKTS_NGAY_TK, homNay); // thống kê theo ngày cho /checknv (7 ngày gần nhất)

  return Response.json({
    hoan_thanh: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_bbmkts_da_xong: soLanMoi,
    bbmkts_gioi_han_ngay: BBMKTS_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: BBMKTS_CHO_TOI_THIEU_MS / 1000,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
    ve_quay: nguoiDung.veQuay || 0,
    ve_quay_moi_nhan: veQuayMoiNhan,
  });
}

// Reset mã bbmkts — hủy nhiệm vụ đang chờ (CHƯA hoàn thành) để tạo lại
// link mới, dùng khi lỡ mất mã/đóng nhầm trang đích. Không cho reset nếu
// đã xong hôm nay rồi, tránh lách giới hạn ngày (song song xuLyResetNhiemVu
// của Link4M / xuLyResetNhiemVuTP của Taplayma).
async function xuLyResetNhiemVuBB(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_BBMKTS_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= BBMKTS_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_hoan_thanh_khong_the_reset" });
  }

  const dangCho = await layNhiemVuBBHienTai(env, uid);
  if (!dangCho || dangCho.ngay !== homNay) {
    return Response.json({ thanh_cong: false, loi: "khong_co_gi_de_reset" });
  }

  await xoaNhiemVuBBHienTai(env, uid);
  return Response.json({ thanh_cong: true });
}

// ==================================================
// 🔗 NHIỆM VỤ VƯỢT LINK LAYMA.NET — SONG SONG với Link4M/Taplayma/bbmkts ở
// trên. Logic đường đi giống hệt các hàm khác (đặt tên "LM" cho gọn), CHỈ
// khác đúng phần cấu hình + gọi API layma.net (endpoint
// /api/admin/shortlink/quicklink, tham số tokenUser + url, trả về JSON
// { success, html } khi thành công).
// ==================================================
async function taoNhiemVuLMMoi(env, uid) {
  for (let lanThu = 0; lanThu < 5; lanThu++) {
    const ma = sinhMaNgauNhien();
    const key = TIEN_TO_NHIEM_VU_LM + ma;
    const daTonTai = await env.USERS.get(key);
    if (daTonTai) continue; // đụng mã hiếm khi xảy ra, thử lại

    await env.USERS.put(key, JSON.stringify({ uid: String(uid), daDung: false, taoLuc: Date.now() }));
    return ma;
  }
  throw new Error("khong_sinh_duoc_ma");
}

async function layNhiemVuLMHienTai(env, uid) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_LM_HIEN_TAI + uid);
  return raw ? JSON.parse(raw) : null;
}

async function luuNhiemVuLMHienTai(env, uid, duLieu) {
  await env.USERS.put(TIEN_TO_NHIEM_VU_LM_HIEN_TAI + uid, JSON.stringify(duLieu));
}

async function xoaNhiemVuLMHienTai(env, uid) {
  await env.USERS.delete(TIEN_TO_NHIEM_VU_LM_HIEN_TAI + uid);
}

async function xuLyTaoNhiemVuLM(env, url, goc) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chặn sớm nếu hôm nay đã dùng hết lượt rồi (tối đa LAYMA_GIOI_HAN_NGAY
  // lần/ngày) — đỡ tốn 1 lượt gọi Layma vô ích
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_LAYMA_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= LAYMA_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_vuot_hom_nay" });
  }

  // Còn nhiệm vụ đang chờ, chưa hoàn thành, chưa hết hạn → trả lại ĐÚNG
  // link cũ, không tạo mới (giống cơ chế của Link4M/Taplayma/bbmkts).
  const dangCho = await layNhiemVuLMHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ thanh_cong: true, link: dangCho.link });
  }

  let ma;
  try {
    ma = await taoNhiemVuLMMoi(env, uid);
  } catch {
    return Response.json({ thanh_cong: false, loi: "khong_sinh_duoc_ma" }, { status: 500 });
  }

  const trangDich = `${goc}/nvlm/${ma}`;
  const apiUrl = `https://api.layma.net/api/admin/shortlink/quicklink?tokenUser=${env.LAYMA_API_TOKEN}&format=json&url=${encodeURIComponent(trangDich)}`;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (data.success && data.html) {
      await luuNhiemVuLMHienTai(env, uid, { ma, link: data.html, taoLuc: Date.now(), ngay: homNay });
      return Response.json({ thanh_cong: true, link: data.html });
    }
    return Response.json({ thanh_cong: false, loi: "loi_khong_ro" });
  } catch (e) {
    return Response.json({ thanh_cong: false, loi: String(e) }, { status: 500 });
  }
}

// Trạng thái hiện tại của nhiệm vụ Layma — frontend gọi lúc mở app để
// khôi phục link cũ, biết đã hoàn thành hôm nay chưa, đã vượt bao nhiêu
// lượt hôm nay, và hiện số dư (song song các hàm xuLyNhiemVuHienTai* khác).
async function xuLyNhiemVuHienTaiLM(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const nguoiDung = await layNguoiDung(env, uid);
  const coin = nguoiDung ? nguoiDung.coin || 0 : 0;

  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_LAYMA_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  const lanCuoi = Number((await env.USERS.get(TIEN_TO_LAYMA_LAN_CUOI + uid)) || 0);

  const trangThaiChung = {
    coin,
    ve_quay: nguoiDung ? nguoiDung.veQuay || 0 : 0,
    so_lan_layma_da_xong: soLanDaXong,
    layma_gioi_han_ngay: LAYMA_GIOI_HAN_NGAY,
    layma_lan_cuoi: lanCuoi,
    layma_cho_toi_thieu_giay: LAYMA_CHO_TOI_THIEU_MS / 1000,
  };

  if (soLanDaXong >= LAYMA_GIOI_HAN_NGAY) {
    return Response.json({ trang_thai: "da_hoan_thanh", ...trangThaiChung });
  }

  const dangCho = await layNhiemVuLMHienTai(env, uid);
  if (dangCho && dangCho.ngay === homNay && Date.now() - dangCho.taoLuc <= TTL_NHIEM_VU_MS) {
    return Response.json({ trang_thai: "dang_cho", link: dangCho.link, ...trangThaiChung });
  }

  return Response.json({ trang_thai: "chua_co", ...trangThaiChung });
}

async function xuLyXacNhanNhiemVuLM(env, url) {
  const uid = url.searchParams.get("uid");
  const ma = url.searchParams.get("ma");
  if (!uid || !ma) return Response.json({ hoan_thanh: false, loi: "thieu_tham_so" }, { status: 400 });

  const homNay = ngayVnHomNay();

  // Chốt chặn thật — dù có lách qua bước tạo link thế nào cũng dừng ở đây
  const keySoLan = TIEN_TO_LAYMA_SO_LAN_NGAY + uid + ":" + homNay;
  const soLanDaXong = Number((await env.USERS.get(keySoLan)) || 0);
  if (soLanDaXong >= LAYMA_GIOI_HAN_NGAY) {
    return Response.json({ hoan_thanh: false, loi: "da_vuot_hom_nay" });
  }

  const key = TIEN_TO_NHIEM_VU_LM + ma;
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
  await env.USERS.put(TIEN_TO_LAYMA_LAN_CUOI + uid, String(Date.now()));
  await xoaNhiemVuLMHienTai(env, uid); // dọn con trỏ, nhiệm vụ này xong rồi

  // Cộng thưởng coin — CỐ ĐỊNH LAYMA_COIN_THUONG (giống Link4M/bbmkts, khác
  // Taplayma vốn random trong khoảng)
  const soCoinCong = LAYMA_COIN_THUONG;
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_VUOT_LINK); // XP đào/lượt vượt link, giống các nguồn khác

  // 🎒 Chỉ tặng vé quay khi hoàn thành ĐỦ LAYMA_GIOI_HAN_NGAY (2) lượt
  // trong ngày — giống Taplayma, khác Link4M/bbmkts (tặng ngay mỗi lượt).
  let veQuayMoiNhan = false;
  if (soLanMoi >= LAYMA_GIOI_HAN_NGAY) {
    nguoiDung.veQuay = (nguoiDung.veQuay || 0) + LAYMA_VE_QUAY_THUONG;
    veQuayMoiNhan = true;
  }

  await congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung); // chỉ tính vào BXH Mời Bạn nếu vừa đạt Lv2 (KHÔNG cộng thêm coin)
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);
  await tangBoDemToanCuc(env, KEY_TONG_LUOT_LAYMA); // thống kê all-time
  await tangBoDemNgay(env, TIEN_TO_LAYMA_NGAY_TK, homNay); // thống kê theo ngày cho /checknv (7 ngày gần nhất)

  return Response.json({
    hoan_thanh: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_layma_da_xong: soLanMoi,
    layma_gioi_han_ngay: LAYMA_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: LAYMA_CHO_TOI_THIEU_MS / 1000,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
    ve_quay: nguoiDung.veQuay || 0,
    ve_quay_moi_nhan: veQuayMoiNhan,
  });
}

// Reset mã Layma — hủy nhiệm vụ đang chờ (CHƯA hoàn thành) để tạo lại
// link mới, dùng khi lỡ mất mã/đóng nhầm trang đích. Không cho reset nếu
// đã xong hôm nay rồi, tránh lách giới hạn ngày (song song các hàm
// xuLyResetNhiemVu* khác).
async function xuLyResetNhiemVuLM(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const homNay = ngayVnHomNay();
  const soLanDaXong = Number((await env.USERS.get(TIEN_TO_LAYMA_SO_LAN_NGAY + uid + ":" + homNay)) || 0);
  if (soLanDaXong >= LAYMA_GIOI_HAN_NGAY) {
    return Response.json({ thanh_cong: false, loi: "da_hoan_thanh_khong_the_reset" });
  }

  const dangCho = await layNhiemVuLMHienTai(env, uid);
  if (!dangCho || dangCho.ngay !== homNay) {
    return Response.json({ thanh_cong: false, loi: "khong_co_gi_de_reset" });
  }

  await xoaNhiemVuLMHienTai(env, uid);
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

// Trang đích /nvtp/<ma> — song song xuLyTrangNhiemVu() của Link4M ở trên,
// đọc từ namespace mã riêng TIEN_TO_NHIEM_VU_TP.
async function xuLyTrangNhiemVuTP(env, ma) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_TP + ma);
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

// Trang đích /nvbb/<ma> — song song xuLyTrangNhiemVu() của Link4M /
// xuLyTrangNhiemVuTP() của Taplayma, đọc từ namespace mã riêng
// TIEN_TO_NHIEM_VU_BB.
async function xuLyTrangNhiemVuBB(env, ma) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_BB + ma);
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

// Trang đích /nvlm/<ma> — song song xuLyTrangNhiemVu() của Link4M /
// xuLyTrangNhiemVuTP() của Taplayma / xuLyTrangNhiemVuBB() của bbmkts, đọc
// từ namespace mã riêng TIEN_TO_NHIEM_VU_LM.
async function xuLyTrangNhiemVuLM(env, ma) {
  const raw = await env.USERS.get(TIEN_TO_NHIEM_VU_LM + ma);
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
  const soCoinCong = Number(env.THUONG_COIN_NHIEM_VU || 10000); // nếu đã đặt biến môi trường THUONG_COIN_NHIEM_VU trên Worker thì cần cập nhật giá trị đó luôn, vì nó được ưu tiên hơn số mặc định này
  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinCong;
  congCoin(nguoiDung, soCoinCong);
  congXpDaoVaLenCap(nguoiDung, XP_MOI_LUOT_VUOT_LINK); // +15 XP đào/lượt vượt link

  // 🎒 Mỗi lần hoàn thành (nay chỉ có đúng 1 lượt/ngày, khớp
  // LINK4M_GIOI_HAN_NGAY = 1) tặng ngay 1 vé quay — dùng ở tab "Làm thêm"
  // (ô Quay thưởng).
  nguoiDung.veQuay = (nguoiDung.veQuay || 0) + 1;
  const veQuayMoiNhan = true;

  await congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung); // chỉ tính vào BXH Mời Bạn nếu vừa đạt Lv2 (KHÔNG cộng thêm coin)
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinCong);
  await tangBoDemToanCuc(env, KEY_TONG_LUOT_LINK4M); // thống kê all-time (không hiển thị nữa nhưng vẫn giữ để không mất dữ liệu)
  await tangBoDemNgay(env, TIEN_TO_LINK4M_NGAY_TK, homNay); // thống kê theo ngày cho /checknv (7 ngày gần nhất)

  return Response.json({
    hoan_thanh: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinCong,
    so_lan_link4m_da_xong: soLanMoi,
    link4m_gioi_han_ngay: LINK4M_GIOI_HAN_NGAY,
    cho_toi_thieu_giay: LINK4M_CHO_TOI_THIEU_MS / 1000,
    cap_dao: nguoiDung.capDao || 1,
    xp_dao: nguoiDung.xpDao || 0,
    ve_quay: nguoiDung.veQuay || 0,
    ve_quay_moi_nhan: veQuayMoiNhan,
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
  const soVeQuayNhanDuoc = giftcode.veQuayThuong || 0; // 0 nếu mã không tặng vé quay (gift code cũ hoặc admin không dùng tham số veN)

  const nguoiDung = (await layNguoiDung(env, uid)) || { coin: 0, tongDaKiem: 0 };
  nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinNhanDuoc;
  congCoin(nguoiDung, soCoinNhanDuoc);
  if (soVeQuayNhanDuoc > 0) nguoiDung.veQuay = (nguoiDung.veQuay || 0) + soVeQuayNhanDuoc;
  await luuNguoiDung(env, uid, nguoiDung);
  await congHoaHongGioiThieu(env, uid, soCoinNhanDuoc);

  return Response.json({
    thanh_cong: true,
    coin: nguoiDung.coin,
    coin_cong: soCoinNhanDuoc,
    ve_quay: nguoiDung.veQuay || 0,
    ve_quay_cong: soVeQuayNhanDuoc,
    ma,
  });
}

// ==================================================
// 🏆 BẢNG XẾP HẠNG — "Đua Top Xu": xếp theo XU KIẾM ĐƯỢC TRONG MÙA GIẢI
// hiện tại. Chỉ Top 10 mới nhận phần thưởng khi kết thúc mùa giải — thưởng
// được TỰ ĐỘNG cộng thẳng vào ví ngay khi phát hiện mùa kết thúc (không
// cần admin thao tác gì), xem traoThuongMuaGiaiDaKetThucNeuCo() bên dưới.
//
// Điểm số tính THEO MÙA (không phải lũy kế toàn thời gian): mỗi user lưu 1
// "mốc mùa giải" (mocMuaGiai) chụp lại tongDaKiem tại thời điểm mùa hiện
// tại bắt đầu quét user đó lần đầu (lazy — chỉ ghi lại khi phát hiện số
// mùa đã đổi). Điểm hiển thị = giá trị lũy kế hiện tại − giá trị tại mốc.
// Nhờ vậy KHÔNG cần sửa mọi nơi cộng coin trong toàn bộ file, mùa mới tự
// "reset" điểm về 0 ngay lần quét đầu tiên của mùa đó.
//
// Để tránh quét toàn bộ KV (tốn CPU time) mỗi lần người dùng mở app, bảng
// được TÍNH TRƯỚC và lưu vào cache, làm mới mỗi 10 phút bằng Cron Trigger
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

// Tương tự damBaoMocMuaGiai() nhưng cho BXH "Đua Top Mời Bạn" — mốc là số
// bạn ĐÃ ĐẠT LV2 MÁY ĐÀO (soBanBeDatLv2) tại thời điểm mùa hiện tại bắt
// đầu — KHÁC với soBanBeMoi (tổng đã mời, dùng cho thưởng 80 coin/tab Bạn
// bè, không cần Lv2).
async function damBaoMocMuaGiaiMoiBan(env, uid, nguoiDung, soMuaHienTai) {
  let moc = nguoiDung.mocMuaGiaiMoiBan;
  if (!moc || moc.so_mua !== soMuaHienTai) {
    const soBanBeHienTai = nguoiDung.soBanBeDatLv2 || 0;
    moc = { so_mua: soMuaHienTai, so_ban_be_goc: soBanBeHienTai };
    nguoiDung.mocMuaGiaiMoiBan = moc;
    await luuNguoiDung(env, uid, nguoiDung);
  }
  return moc;
}

// Trần AN TOÀN chỉ để chặn trường hợp cực đoan (app có hàng chục nghìn
// user cùng lúc) — KHÔNG phải giới hạn "chỉ xét N user đầu" như biến
// QUET_TOI_DA cũ. Với quy mô hiện tại, con số này gần như không bao giờ
// chạm tới, nên MỌI user đủ điều kiện đều được xét vào BXH.
const TRAN_AN_TOAN_QUET_BXH = 20000;

// Tính CẢ 2 bảng xếp hạng ("Đua Top Xu" + "Đua Top Mời Bạn") trong CÙNG 1
// lượt quét D1 duy nhất — vì cả 2 đều cần duyệt toàn bộ user, gộp lại
// tránh phải quét D1 2 lần (tiết kiệm read) và gộp việc ghi mốc mùa giải
// của cả 2 bảng vào CHUNG 1 object user → CHUNG 1 lượt db.batch() (tiết
// kiệm write), thay vì 2 vòng quét + 2 batch riêng biệt.
async function tinhCaHaiBangXepHang(env, soMuaHienTai) {
  const ketQuaKiemXu = [];
  const ketQuaMoiBan = [];
  const canGhiMocMoi = []; // { uid, nguoiDung } — user vừa phát hiện đổi mùa (ở ít nhất 1 trong 2 mốc), cần lưu mốc mới

  let hangDoi;
  try {
    // 1 CÂU SQL DUY NHẤT lấy toàn bộ user (ns='users', key bắt đầu bằng
    // "user:") thay vì gọi layNguoiDung() từng người một trong vòng lặp —
    // trước đây cách cũ buộc phải "cắt" ở 50 user đầu tiên (luôn CỐ ĐỊNH
    // cùng 50 người theo thứ tự key) để tránh tốn quá nhiều round-trip,
    // khiến user kiếm coin nhiều nhưng không nằm trong 50 người đó thì
    // KHÔNG BAO GIỜ được xét lên BXH dù có kiếm bao nhiêu đi nữa. Gộp lại
    // thành 1 query giúp quét được TẤT CẢ user chỉ với 1 lượt gọi D1.
    // Dùng range "key >= / key <" (KHÔNG dùng LIKE+ESCAPE) để SQLite tận
    // dụng được index — xem giải thích chi tiết ở capTrenChoPrefix().
    const capTren = capTrenChoPrefix(TIEN_TO_USER);
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM kv WHERE ns = 'users' AND key >= ?1 AND key < ?2 LIMIT ?3"
    )
      .bind(TIEN_TO_USER, capTren, TRAN_AN_TOAN_QUET_BXH)
      .all();
    hangDoi = results;
  } catch (e) {
    // Lỗi D1 (timeout, quá tải...) — trả về rỗng, không làm hỏng cache cũ
    // (xuLyBangXepHang vẫn giữ cache trước đó nếu lần làm mới này lỗi).
    return { kiem_xu: [], moi_ban: [] };
  }

  for (const hang of hangDoi) {
    const uid = hang.key.slice(TIEN_TO_USER.length);
    let nguoiDung;
    try {
      nguoiDung = JSON.parse(hang.value);
    } catch (e) {
      continue; // dữ liệu hỏng, bỏ qua user này
    }

    let canGhi = false;

    // ── Mốc "Đua Top Xu" ──
    const coinHienTai = nguoiDung.tongDaKiem != null ? nguoiDung.tongDaKiem : nguoiDung.coin || 0;
    let mocXu = nguoiDung.mocMuaGiai;
    if (!mocXu || mocXu.so_mua !== soMuaHienTai) {
      mocXu = { so_mua: soMuaHienTai, coin_goc: coinHienTai };
      nguoiDung.mocMuaGiai = mocXu;
      canGhi = true;
    }
    const daKiemTrongMua = Math.max(0, coinHienTai - mocXu.coin_goc);

    // ── Mốc "Đua Top Mời Bạn" ── (soBanBeDatLv2 CHỈ tính bạn đã đạt Lv2 máy
    // đào — KHÁC soBanBeMoi là tổng đã mời dùng cho thưởng 80 coin/tab Bạn bè)
    const soBanBeHienTai = nguoiDung.soBanBeDatLv2 || 0;
    let mocMoiBan = nguoiDung.mocMuaGiaiMoiBan;
    if (!mocMoiBan || mocMoiBan.so_mua !== soMuaHienTai) {
      mocMoiBan = { so_mua: soMuaHienTai, so_ban_be_goc: soBanBeHienTai };
      nguoiDung.mocMuaGiaiMoiBan = mocMoiBan;
      canGhi = true;
    }
    const daMoiTrongMua = Math.max(0, soBanBeHienTai - mocMoiBan.so_ban_be_goc);

    if (canGhi) canGhiMocMoi.push({ uid, nguoiDung });

    // Trước đây nếu user KHÔNG có cả `ten` lẫn `username` (vd tài khoản cũ
    // từ trước khi /start lưu đủ 2 trường này, hoặc dữ liệu import thiếu),
    // code sẽ ÂM THẦM loại bỏ hẳn user đó khỏi BXH bằng "continue" — dù
    // kiếm bao nhiêu xu cũng không bao giờ lên hạng được. Giờ dùng tên dự
    // phòng "Người chơi #{4 số cuối UID}" để KHÔNG ai bị loại khỏi BXH chỉ
    // vì thiếu tên hiển thị.
    const tenHienThi =
      (nguoiDung.ten && nguoiDung.ten.trim()) ||
      (nguoiDung.username ? `@${nguoiDung.username}` : "") ||
      `Người chơi #${String(uid).slice(-4)}`;

    if (daKiemTrongMua >= MUC_TOI_THIEU_KIEM_XU) {
      ketQuaKiemXu.push({ uid, ten: tenHienThi, gia_tri: daKiemTrongMua });
    }
    if (daMoiTrongMua >= MUC_TOI_THIEU_MOI_BAN) {
      ketQuaMoiBan.push({ uid, ten: tenHienThi, gia_tri: daMoiTrongMua });
    }
  }

  // Ghi lại mốc mùa giải mới (chỉ user vừa phát hiện đổi mùa, gộp CẢ 2 mốc
  // vào CÙNG 1 object user) — gộp thành 1 lượt db.batch() DUY NHẤT thay vì
  // N request riêng lẻ, để không đội số round-trip lên dù có hàng trăm
  // user cần cập nhật cùng lúc (vd ngay sau khi mùa giải mới mở).
  if (canGhiMocMoi.length > 0) {
    try {
      const cacCauLenh = canGhiMocMoi.map(({ uid, nguoiDung }) =>
        d1PutCauLenh(env.DB, "users", TIEN_TO_USER + uid, JSON.stringify(nguoiDung))
      );
      await env.DB.batch(cacCauLenh);
    } catch (e) {
      console.error("Không ghi được mốc mùa giải mới cho user (batch):", e);
    }
  }

  ketQuaKiemXu.sort((a, b) => b.gia_tri - a.gia_tri);
  ketQuaMoiBan.sort((a, b) => b.gia_tri - a.gia_tri);
  return { kiem_xu: ketQuaKiemXu.slice(0, 50), moi_ban: ketQuaMoiBan.slice(0, 50) };
}

// Tính lại + ghi cache — được gọi bởi Cron Trigger mỗi 10 phút. Tính CẢ 2
// bảng ("Đua Top Xu" + "Đua Top Mời Bạn") trong CÙNG 1 lượt quét D1, lưu
// chung 1 object cache — /bang-xep-hang chỉ đọc đúng field cần theo "loai".
async function lamMoiCacheBangXepHang(env, muaGiai) {
  const mg = muaGiai || (await layHoacTaoMuaGiai(env));
  const { kiem_xu, moi_ban } = await tinhCaHaiBangXepHang(env, mg.so);
  const duLieu = { so_mua: mg.so, kiem_xu, moi_ban, cap_nhat_luc: Date.now() };
  try {
    await env.USERS.put(KEY_CACHE_BANG_XEP_HANG, JSON.stringify(duLieu));
  } catch (e) {
    console.error("Không ghi được cache-bang-xep-hang vào KV (có thể hết quota put()/ngày):", e);
  }
  return duLieu;
}

// Mùa giải BXH — lưu số mùa + mốc bắt đầu/kết thúc trong KV. Tự động mở
// mùa mới ngay khi phát hiện mùa hiện tại đã hết hạn (đọc lazy, không cần
// cron riêng). Khi kết thúc mùa, Top 10 được TỰ ĐỘNG trao thưởng ngay
// (xem traoThuongMuaGiaiDaKetThucNeuCo() bên dưới, gọi TRƯỚC khi hàm này
// ghi đè sang số mùa mới) rồi mùa mới tự mở ở lượt đọc kế tiếp — điểm 2
// bảng tự về 0 nhờ cơ chế mốc mùa giải ở trên.
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

// Đọc mốc "đã trao thưởng tới mùa số mấy" cho mỗi bảng — { kiem_xu, moi_ban }.
async function layMocDaTraoThuong(env) {
  const raw = await env.USERS.get(KEY_MUA_DA_TRAO_THUONG);
  return raw ? JSON.parse(raw) : { kiem_xu: 0, moi_ban: 0 };
}

// Cộng thẳng coin vào ví cho Top N người đứng đầu 1 danh sách xếp hạng đã
// tính sẵn (kiem_xu hoặc moi_ban trong cache) — dùng bangThuong[hạng-1] làm
// mức thưởng. Trả về danh sách người thắng thực sự nhận được thưởng (để
// dựng tin thông báo) — bỏ qua an toàn nếu tài khoản không còn tồn tại.
async function traoThuongTop10(env, danhSachXepHang, bangThuong) {
  const nguoiThang = [];
  const soNguoiTrao = Math.min(TOP_NHAN_THUONG, (danhSachXepHang || []).length);
  for (let i = 0; i < soNguoiTrao; i++) {
    const hang = danhSachXepHang[i];
    const soCoinThuong = bangThuong[i] || 0;
    if (soCoinThuong <= 0) continue;

    const nguoiDung = await layNguoiDung(env, hang.uid);
    if (!nguoiDung) continue; // tài khoản không còn tồn tại — bỏ qua, không làm hỏng cả lượt trao

    congCoin(nguoiDung, soCoinThuong);
    nguoiDung.tongDaKiem = (nguoiDung.tongDaKiem || 0) + soCoinThuong; // thưởng mùa giải cũng tính vào lũy kế (ảnh hưởng mốc mùa kế tiếp, hợp lý vì đây là coin thật kiếm được)
    await luuNguoiDung(env, hang.uid, nguoiDung);
    nguoiThang.push({ uid: hang.uid, ten: hang.ten, coin: soCoinThuong });
  }
  return nguoiThang;
}

// Dựng nội dung tin thông báo trao thưởng Top 10 khi 1 mùa giải kết thúc —
// gửi vào NHÓM TRÒ CHUYỆN, cùng phong cách với thông báo gift code / thanh
// toán rút tiền.
function xayDungTinTraoThuongMuaGiai(soMuaVuaKetThuc, tenBang, nguoiThang) {
  const dong = nguoiThang.map((nd, idx) => {
    const huyChuong = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
    return `${huyChuong} ${nd.ten} — +${(nd.coin || 0).toLocaleString("vi-VN")} coin`;
  });
  return (
    `🏆 KẾT THÚC MÙA GIẢI #${soMuaVuaKetThuc} — ${tenBang}\n\n` +
    `Top ${nguoiThang.length} đã được TỰ ĐỘNG cộng thưởng thẳng vào ví:\n\n` +
    dong.join("\n") +
    `\n\n💸 Cày coin, đua top mùa mới ngay tại Vua Cày Tiền 💸`
  );
}

// Kiểm tra + TỰ ĐỘNG trao thưởng Top 10 ngay khi phát hiện 1 mùa giải vừa
// kết thúc — PHẢI được gọi TRƯỚC bất kỳ chỗ nào làm mới cache sang mùa mới
// (lamMoiCacheBangXepHang), vì cơ chế này dựa vào cache HIỆN TẠI (vẫn còn
// giữ đúng bảng xếp hạng CUỐI CÙNG của mùa vừa kết thúc — cache chỉ được
// làm mới mỗi 10 phút nên gần như chắc chắn là bản chốt sổ) để biết ai
// thắng, thay vì phải lưu snapshot riêng.
//
// Idempotent qua KEY_MUA_DA_TRAO_THUONG: mỗi mùa chỉ được trao đúng 1 lần
// cho mỗi bảng (kiem_xu / moi_ban riêng biệt vì moi_ban có thể chưa mở ở
// mùa đó) — đánh dấu "đã trao" NGAY SAU khi trao xong. Chấp nhận rủi ro
// race cực nhỏ nếu 2 lượt gọi trùng khớp hoàn toàn cùng lúc, giống cách
// các bộ đếm/gifcode khác trong file đang chấp nhận, để đổi lấy code đơn
// giản (không cần lock phân tán).
async function traoThuongMuaGiaiDaKetThucNeuCo(env) {
  const muaHienTai = await layHoacTaoMuaGiai(env); // gọi để kích hoạt rollover nếu mùa cũ đã hết hạn
  const rawCache = await env.USERS.get(KEY_CACHE_BANG_XEP_HANG);
  if (!rawCache) return;

  let cache;
  try {
    cache = JSON.parse(rawCache);
  } catch (e) {
    return; // cache hỏng — bỏ qua, lần làm mới cache kế tiếp sẽ tự ghi lại đúng
  }

  // Cache thuộc mùa CŨ HƠN mùa hiện tại → đây chính là bảng xếp hạng CUỐI
  // CÙNG của mùa vừa kết thúc (chưa kịp làm mới sang mùa mới).
  if (!cache.so_mua || cache.so_mua >= muaHienTai.so) return;

  const soMuaVuaKetThuc = cache.so_mua;
  const daTrao = await layMocDaTraoThuong(env);
  let coThayDoi = false;

  if ((daTrao.kiem_xu || 0) < soMuaVuaKetThuc) {
    const nguoiThangXu = await traoThuongTop10(env, cache.kiem_xu, PHAN_THUONG_KIEM_XU);
    daTrao.kiem_xu = soMuaVuaKetThuc;
    coThayDoi = true;
    if (nguoiThangXu.length > 0 && env.NHOM_CHAT) {
      try {
        await telegramApi(env, "sendMessage", {
          chat_id: env.NHOM_CHAT,
          text: xayDungTinTraoThuongMuaGiai(soMuaVuaKetThuc, "💰 Đua Top Xu", nguoiThangXu),
        });
      } catch (e) {
        console.error("Lỗi gửi thông báo trao thưởng Đua Top Xu:", e);
      }
    }
  }

  // BXH Mời Bạn chỉ tồn tại từ mùa MOI_BAN_MO_TU_MUA trở đi — mùa trước đó
  // không có gì để trao (cache.moi_ban rỗng vì board chưa mở trong mùa đó).
  if (soMuaVuaKetThuc >= MOI_BAN_MO_TU_MUA && (daTrao.moi_ban || 0) < soMuaVuaKetThuc) {
    const nguoiThangMoiBan = await traoThuongTop10(env, cache.moi_ban, PHAN_THUONG_MOI_BAN);
    daTrao.moi_ban = soMuaVuaKetThuc;
    coThayDoi = true;
    if (nguoiThangMoiBan.length > 0 && env.NHOM_CHAT) {
      try {
        await telegramApi(env, "sendMessage", {
          chat_id: env.NHOM_CHAT,
          text: xayDungTinTraoThuongMuaGiai(soMuaVuaKetThuc, "👥 Đua Top Mời Bạn", nguoiThangMoiBan),
        });
      } catch (e) {
        console.error("Lỗi gửi thông báo trao thưởng Đua Top Mời Bạn:", e);
      }
    }
  }

  if (coThayDoi) {
    try {
      await env.USERS.put(KEY_MUA_DA_TRAO_THUONG, JSON.stringify(daTrao));
    } catch (e) {
      console.error("Không ghi được mốc đã trao thưởng mùa giải:", e);
    }
  }
}

async function xuLyBangXepHang(env, url, ctx) {
  const loaiTho = url.searchParams.get("loai") || "kiem-xu";
  const loai = loaiTho === "moi-ban" ? "moi_ban" : "kiem_xu"; // key trong object cache
  const uid = url.searchParams.get("uid");

  const mucToiThieu = loai === "moi_ban" ? MUC_TOI_THIEU_MOI_BAN : MUC_TOI_THIEU_KIEM_XU;
  const bangThuong = loai === "moi_ban" ? PHAN_THUONG_MOI_BAN : PHAN_THUONG_KIEM_XU;
  const donViGiaTri = loai === "moi_ban" ? "bạn" : "xu";

  try {
    const muaGiai = await layHoacTaoMuaGiai(env);

    // BXH Mời Bạn khóa trong suốt mùa giải #1 — chỉ mở từ mùa #2 trở đi
    // (tức là ngay khi mùa #1 kết thúc). Trả sớm, không cần đọc cache.
    if (loai === "moi_ban" && muaGiai.so < MOI_BAN_MO_TU_MUA) {
      return Response.json({
        mua_giai: muaGiai,
        loai,
        don_vi_gia_tri: donViGiaTri,
        muc_toi_thieu_bxh: mucToiThieu,
        top_nhan_thuong: TOP_NHAN_THUONG,
        bang_thuong: [],
        bang_xep_hang: [],
        hang_cua_toi: null,
        gia_tri_cua_toi: 0,
        cap_nhat_luc: Date.now(),
        chua_mo: true,
        mo_tu_mua: MOI_BAN_MO_TU_MUA,
      });
    }

    const raw = await env.USERS.get(KEY_CACHE_BANG_XEP_HANG);
    let cache = raw ? JSON.parse(raw) : null;

    if (!cache || !Array.isArray(cache.moi_ban)) {
      // Chưa từng có cache (lần đầu deploy), HOẶC cache cũ từ trước khi có
      // BXH Mời bạn (thiếu field moi_ban) — bắt buộc tính ngay 1 lần để
      // không trả về rỗng mãi (giới hạn quét đã được hạ thấp ở hàm tính
      // để tránh vượt subrequest ngay trong request đầu tiên này).
      cache = await lamMoiCacheBangXepHang(env, muaGiai);
    } else if (cache.so_mua !== muaGiai.so) {
      // Cache thuộc mùa cũ — trả cache cũ ngay cho nhanh (không chặn user
      // chờ tính lại), rồi âm thầm làm mới ở nền qua waitUntil. Cache cũ
      // vẫn hiển thị được (chỉ hơi lệch số mùa 1 nhịp, sẽ tự đúng lại sau).
      // LUÔN kiểm tra + trao thưởng Top 10 của mùa cũ TRƯỚC khi làm mới —
      // đây là đường dẫn NHIỀU KHẢ NĂNG xảy ra nhất (chỉ cần 1 user mở tab
      // BXH sau khi mùa kết thúc), nên không thể bỏ qua bước này.
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(
          (async () => {
            await traoThuongMuaGiaiDaKetThucNeuCo(env);
            await lamMoiCacheBangXepHang(env, muaGiai);
          })().catch(() => {})
        );
      } else {
        await traoThuongMuaGiaiDaKetThucNeuCo(env);
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
            if (loai === "moi_ban") {
              const moc = await damBaoMocMuaGiaiMoiBan(env, uid, nd, muaGiai.so);
              giaTriCuaToi = Math.max(0, (nd.soBanBeDatLv2 || 0) - moc.so_ban_be_goc);
            } else {
              const moc = await damBaoMocMuaGiai(env, uid, nd, muaGiai.so);
              const coinHienTai = nd.tongDaKiem != null ? nd.tongDaKiem : nd.coin || 0;
              giaTriCuaToi = Math.max(0, coinHienTai - moc.coin_goc);
            }
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
      don_vi_gia_tri: donViGiaTri,
      muc_toi_thieu_bxh: mucToiThieu,
      top_nhan_thuong: TOP_NHAN_THUONG,
      bang_thuong: Array.from({ length: TOP_NHAN_THUONG }, (_, i) => ({ hang: i + 1, coin: bangThuong[i] })),
      bang_xep_hang: danhSach.map((nd, idx) => ({
        hang: idx + 1,
        uid: nd.uid,
        ten: nd.ten,
        gia_tri: nd.gia_tri,
        phan_thuong: idx < TOP_NHAN_THUONG ? { coin: bangThuong[idx] } : { coin: 0 },
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
      don_vi_gia_tri: donViGiaTri,
      muc_toi_thieu_bxh: mucToiThieu,
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
// — NHẬN NGAY, không cần điều kiện gì (chỉ tính 1 lần/người được mời, do
// chỉ gọi khi laNguoiDungMoi === true). Lv2 máy đào KHÔNG ảnh hưởng tới
// khoản thưởng này — chỉ ảnh hưởng tới việc có tính vào BXH Mời Bạn hay
// không, xem congBxhMoiBanNeuDuDieuKien() bên dưới.
async function congThuongMoiBanThanhCong(env, refUid) {
  const nguoiGioiThieu = await layNguoiDung(env, refUid);
  if (!nguoiGioiThieu) return;
  nguoiGioiThieu.coin = (nguoiGioiThieu.coin || 0) + THUONG_MOI_BAN_THANH_CONG;
  nguoiGioiThieu.tongDaKiem = (nguoiGioiThieu.tongDaKiem || 0) + THUONG_MOI_BAN_THANH_CONG;
  nguoiGioiThieu.coinTuBanBe = (nguoiGioiThieu.coinTuBanBe || 0) + THUONG_MOI_BAN_THANH_CONG; // cộng dồn riêng "coin kiếm được từ bạn bè", hiển thị ở tab Bạn bè
  nguoiGioiThieu.soBanBeMoi = (nguoiGioiThieu.soBanBeMoi || 0) + 1; // tổng số bạn đã mời thành công — hiển thị ở tab Bạn bè, KHÔNG dùng cho BXH
  await luuNguoiDung(env, refUid, nguoiGioiThieu);
}

// Đánh dấu 1 người trong danh sách bạn bè của refUid là ĐÃ đạt Lv2 máy đào
// — chỉ để HIỂN THỊ trạng thái trong tab Bạn bè, không liên quan tới coin.
async function danhDauBanBeDatLv2(env, refUid, uidBanMoi) {
  const key = TIEN_TO_BAN_BE + refUid;
  const raw = await env.USERS.get(key);
  if (!raw) return;
  const danhSach = JSON.parse(raw);
  const idx = danhSach.findIndex((nb) => String(nb.uid) === String(uidBanMoi));
  if (idx === -1) return;
  danhSach[idx].daDatLv2 = true;
  await env.USERS.put(key, JSON.stringify(danhSach));
}

// CHỈ dùng cho BXH "Đua Top Mời Bạn" — KHÔNG cộng thêm coin (coin mời bạn
// đã được cộng NGAY lúc /start ở congThuongMoiBanThanhCong rồi). Kiểm tra:
// user này có phải được mời (gioiThieuBoi) không, đã đạt Lv2 máy đào chưa,
// và CHƯA từng được tính vào BXH của người mời (refBxhDaTinh) — nếu đủ,
// +1 vào soBanBeDatLv2 của người mời TRỰC TIẾP (chỉ tầng 1, không lan
// xuống tầng 2/3). Gọi ở mọi nơi capDao có thể tăng, TRƯỚC khi
// luuNguoiDung() người dùng hiện tại — vì hàm này mutate nguoiDung.refBxhDaTinh.
async function congBxhMoiBanNeuDuDieuKien(env, uid, nguoiDung) {
  if (!nguoiDung.gioiThieuBoi) return;
  if (nguoiDung.refBxhDaTinh) return;
  if ((nguoiDung.capDao || 1) < 2) return;
  nguoiDung.refBxhDaTinh = true; // đánh dấu trước để không tính trùng, caller sẽ luuNguoiDung() sau

  const nguoiGioiThieu = await layNguoiDung(env, nguoiDung.gioiThieuBoi);
  if (!nguoiGioiThieu) return;
  nguoiGioiThieu.soBanBeDatLv2 = (nguoiGioiThieu.soBanBeDatLv2 || 0) + 1; // CHỈ dùng để xếp hạng BXH Mời Bạn
  await luuNguoiDung(env, nguoiDung.gioiThieuBoi, nguoiGioiThieu);
  await danhDauBanBeDatLv2(env, nguoiDung.gioiThieuBoi, uid);
}

async function xuLyThongTinBanBe(env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return Response.json({ loi: "thieu_uid" }, { status: 400 });

  const raw = await env.USERS.get(TIEN_TO_BAN_BE + uid);
  const danhSach = raw ? JSON.parse(raw) : [];
  const nguoiDung = await layNguoiDung(env, uid);

  // Luôn lấy số lượng từ ĐỘ DÀI mảng ban-be:{uid} — đây là nguồn dữ liệu
  // đầy đủ, luôn được ghi (ghiNhanBanBeMoi) mỗi khi có người mới qua link.
  // TRƯỚC ĐÂY dùng nguoiDung.soBanBeMoi (1 counter riêng) làm ưu tiên số 1,
  // nhưng field này chỉ tồn tại/tăng từ sau khi được thêm vào code — user
  // có lượt mời TỪ TRƯỚC đó sẽ bị đếm thiếu (vd mảng có 4 người nhưng
  // soBanBeMoi chỉ ghi nhận 1), gây lệch số hiển thị "Bạn đã mời" so với
  // danh sách bên dưới. Bỏ hẳn phụ thuộc vào soBanBeMoi cho số hiển thị.
  return Response.json({
    so_luong: danhSach.length, // tổng bạn đã mời thành công — ĐÃ nhận thưởng 80 coin, không cần Lv2
    so_luong_dat_lv2: nguoiDung ? nguoiDung.soBanBeDatLv2 || 0 : 0, // trong số đó, bao nhiêu bạn đã đạt Lv2 máy đào — CHỈ dùng để tính BXH Mời Bạn
    coin_tu_ban_be: nguoiDung ? nguoiDung.coinTuBanBe || 0 : 0, // tổng coin kiếm được từ bạn bè (thưởng mời thành công + hoa hồng nhiều tầng)
    danh_sach: danhSach.map((nb) => ({ ten: nb.ten, tham_gia_luc: nb.thamGiaLuc, da_dat_lv2: !!nb.daDatLv2 })),
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
  return Boolean(env.ADMIN_WEB_SECRET) && soSanhAnToan(secret, env.ADMIN_WEB_SECRET);
}

// Che 1 phần chuỗi (ID Telegram, số TK...) khi hiển thị công khai ra nhóm —
// giữ vài ký tự đầu/cuối, phần giữa thay bằng ****, giống format thông báo
// thanh toán mẫu (VD: 828****39456).
function cheGiuaChuoi(chuoi, soDauGiu, soCuoiGiu) {
  const s = String(chuoi ?? "");
  if (s.length <= soDauGiu + soCuoiGiu) return s;
  return s.slice(0, soDauGiu) + "****" + s.slice(-soCuoiGiu);
}

// Định dạng "HH:mm:ss dd/MM/yyyy" theo giờ Việt Nam — dùng cho tin thông báo
// thanh toán ở nhóm chat, khớp format trong ảnh mẫu.
function dinhDangThoiGianThanhToan(ts) {
  const d = new Date(ts);
  const gio = d.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
  const ngay = d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }); // dd/mm/yyyy
  return `${gio} ${ngay}`;
}

// Dựng nội dung tin "ĐÃ THANH TOÁN" gửi vào nhóm chat sau khi admin bấm
// Hoàn thành trên trang web duyệt rút tiền — che 1 phần ID Telegram và số
// TK/SĐT để không lộ thông tin nhạy cảm của user ra nhóm công khai.
function xayDungTinThanhToanNhom(giaoDich) {
  return (
    "🎉 ĐÃ THANH TOÁN\n" +
    `🆔 Telegram: ${cheGiuaChuoi(giaoDich.uid, 3, 5)}\n` +
    `🏦 Phương thức: ${giaoDich.nganHang}\n` +
    `🔢 SĐT/STK: ${cheGiuaChuoi(giaoDich.soTk, 3, 3)}\n` +
    `🥈 Tài nguyên: ${giaoDich.soCoin.toLocaleString("vi-VN")} coin\n` +
    `💰 Số tiền: ${giaoDich.soTien.toLocaleString("vi-VN")}đ\n` +
    `🕐 Thời gian: ${dinhDangThoiGianThanhToan(giaoDich.duyetLuc)}`
  );
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
  // 3 hành động admin có thể chọn trên trang web duyệt rút tiền:
  //   hoan_thanh → đã chuyển khoản thành công, KHÔNG hoàn coin
  //   tu_choi    → admin chủ động từ chối yêu cầu, HOÀN coin
  //   that_bai   → chuyển khoản thất bại (lỗi kỹ thuật, sai thông tin...),
  //                cũng HOÀN coin giống tu_choi nhưng lưu trạng thái riêng
  //                để phân biệt lý do trong lịch sử/thống kê
  if (!uid || !idGiaoDich || !["hoan_thanh", "tu_choi", "that_bai"].includes(hanhDong)) {
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

  // tu_choi (admin từ chối) và that_bai (chuyển khoản lỗi) đều HOÀN coin +
  // trả lại hạn mức ngày/tuần/số lần đã trừ lúc gửi yêu cầu — chỉ khác nhau
  // ở trangThai lưu lại để phân biệt lý do. hoan_thanh thì KHÔNG hoàn gì cả.
  if (hanhDong === "tu_choi" || hanhDong === "that_bai") {
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
  }

  // KHÔNG gửi DM riêng cho user ở bất kỳ trạng thái nào nữa (hoàn thành, từ
  // chối, thất bại) — user tự xem trạng thái/lịch sử ở tab Ví trong app.
  // CHỈ khi HOÀN THÀNH mới thông báo công khai vào nhóm chat; từ chối/thất
  // bại thì không gửi gì cả (tiền chưa thực sự được chuyển).
  if (hanhDong === "hoan_thanh" && env.NHOM_CHAT) {
    try {
      await telegramApi(env, "sendMessage", {
        chat_id: env.NHOM_CHAT,
        text: xayDungTinThanhToanNhom(giaoDich),
      });
    } catch (e) {
      console.error("Lỗi gửi thông báo thanh toán vào NHOM_CHAT:", e);
    }
  }

  return Response.json({ thanh_cong: true });
}

// ==================================================
// 🖥️ WEB ADMIN — QUẢN LÝ NGƯỜI CHƠI + Ô LỆNH
//   GET  /admin/nguoi-choi/danh-sach  → toàn bộ user (lọc theo ?tim=)
//   POST /admin/lenh                  → thực thi 1 lệnh admin dạng text
// Xác thực bằng header X-Admin-Secret, dùng chung xacThucAdminWeb().
// ==================================================
async function xuLyDanhSachNguoiChoiAdmin(env, request, url) {
  if (!xacThucAdminWeb(env, request)) {
    return Response.json({ loi: "khong_co_quyen" }, { status: 401 });
  }

  const tim = (url.searchParams.get("tim") || "").trim().toLowerCase();
  const capTren = capTrenChoPrefix(TIEN_TO_USER);

  let hangDoi;
  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM kv WHERE ns = 'users' AND key >= ?1 AND key < ?2 ORDER BY key ASC LIMIT ?3"
    ).bind(TIEN_TO_USER, capTren, 20000).all();
    hangDoi = results;
  } catch (e) {
    return Response.json({ loi: "loi_truy_van_d1", chi_tiet: String(e) }, { status: 500 });
  }

  const danhSach = [];
  for (const hang of hangDoi) {
    const uid = hang.key.slice(TIEN_TO_USER.length);
    let nd;
    try {
      nd = JSON.parse(hang.value);
    } catch (e) {
      continue; // dữ liệu hỏng, bỏ qua user này
    }

    if (tim) {
      const khop =
        uid.includes(tim) ||
        (nd.ten || "").toLowerCase().includes(tim) ||
        (nd.username || "").toLowerCase().includes(tim);
      if (!khop) continue;
    }

    danhSach.push({
      uid,
      ten: nd.ten || "",
      username: nd.username || null,
      coin: nd.coin || 0,
      tong_da_kiem: nd.tongDaKiem || 0,
      cap_dao: nd.capDao || 1,
      xp_dao: nd.xpDao || 0,
      ve_quay: nd.veQuay || 0,
      dang_dao: !!(nd.dao && nd.dao.dangDao),
      ngay_tham_gia: nd.ngay_tham_gia || "",
      gioi_thieu_boi: nd.gioiThieuBoi || null,
    });
  }

  danhSach.sort((a, b) => b.tong_da_kiem - a.tong_da_kiem);
  return Response.json({ tong_so: danhSach.length, danh_sach: danhSach.slice(0, 2000) });
}

// Sửa trực tiếp thông tin 1 người chơi từ web admin (coin, tổng đã kiếm,
// cấp đào, XP đào, tên, username). CHỈ ghi đè các field ĐƯỢC GỬI LÊN (field
// nào không có trong body thì giữ nguyên giá trị cũ) — cho phép sửa 1 vài
// trường mà không cần gửi lại toàn bộ object user. Validate số không âm,
// nguyên vẹn (capDao tối đa CAP_DAO_TOI_DA) để tránh lỡ tay phá dữ liệu.
async function xuLySuaNguoiChoiAdmin(env, request) {
  if (!xacThucAdminWeb(env, request)) {
    return Response.json({ thanh_cong: false, loi: "khong_co_quyen" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ thanh_cong: false, loi: "body_khong_hop_le" }, { status: 400 });
  }

  const uid = body && body.uid ? String(body.uid) : "";
  if (!uid) return Response.json({ thanh_cong: false, loi: "thieu_uid" }, { status: 400 });

  const nguoiDung = await layNguoiDung(env, uid);
  if (!nguoiDung) return Response.json({ thanh_cong: false, loi: "khong_tim_thay" }, { status: 404 });

  // Số nguyên không âm — dùng chung cho coin/tổng đã kiếm/XP.
  function soNguyenKhongAmHopLe(v) {
    return Number.isFinite(v) && Number.isInteger(v) && v >= 0;
  }

  if (body.coin !== undefined) {
    const v = Number(body.coin);
    if (!soNguyenKhongAmHopLe(v)) return Response.json({ thanh_cong: false, loi: "coin_khong_hop_le" });
    nguoiDung.coin = v;
  }
  if (body.tong_da_kiem !== undefined) {
    const v = Number(body.tong_da_kiem);
    if (!soNguyenKhongAmHopLe(v)) return Response.json({ thanh_cong: false, loi: "tong_da_kiem_khong_hop_le" });
    nguoiDung.tongDaKiem = v;
  }
  if (body.cap_dao !== undefined) {
    const v = Number(body.cap_dao);
    if (!soNguyenKhongAmHopLe(v) || v < 1 || v > CAP_DAO_TOI_DA) {
      return Response.json({ thanh_cong: false, loi: "cap_dao_khong_hop_le" });
    }
    nguoiDung.capDao = v;
  }
  if (body.xp_dao !== undefined) {
    const v = Number(body.xp_dao);
    if (!soNguyenKhongAmHopLe(v)) return Response.json({ thanh_cong: false, loi: "xp_dao_khong_hop_le" });
    nguoiDung.xpDao = v;
  }
  if (body.ve_quay !== undefined) {
    const v = Number(body.ve_quay);
    if (!soNguyenKhongAmHopLe(v)) return Response.json({ thanh_cong: false, loi: "ve_quay_khong_hop_le" });
    nguoiDung.veQuay = v;
  }
  if (body.ten !== undefined) {
    nguoiDung.ten = String(body.ten).slice(0, 100);
  }
  if (body.username !== undefined) {
    const u = String(body.username).trim().replace(/^@/, "");
    nguoiDung.username = u || null;
  }

  await luuNguoiDung(env, uid, nguoiDung);

  return Response.json({
    thanh_cong: true,
    nguoi_dung: {
      uid,
      ten: nguoiDung.ten || "",
      username: nguoiDung.username || null,
      coin: nguoiDung.coin || 0,
      tong_da_kiem: nguoiDung.tongDaKiem || 0,
      cap_dao: nguoiDung.capDao || 1,
      xp_dao: nguoiDung.xpDao || 0,
      ve_quay: nguoiDung.veQuay || 0,
    },
  });
}

// Thực thi lệnh admin từ web — chỉ hỗ trợ tập lệnh KHÔNG cần reply message
// Telegram (đọc dữ liệu / bật tắt cấu hình). Không cần laAdmin() vì đã xác
// thực bằng ADMIN_WEB_SECRET ở tầng trên rồi.
async function xuLyLenhAdminWeb(env, request) {
  if (!xacThucAdminWeb(env, request)) {
    return Response.json({ thanh_cong: false, loi: "khong_co_quyen" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ thanh_cong: false, loi: "body_khong_hop_le" }, { status: 400 });
  }

  const dong = (body && body.lenh ? String(body.lenh) : "").trim();
  if (!dong) return Response.json({ thanh_cong: false, loi: "thieu_lenh" }, { status: 400 });

  const phan = dong.split(/\s+/);
  const lenh = phan[0].toLowerCase();

  try {
    switch (lenh) {
    	case "/mute": {
  const uid = phan[1];
  const phut = phan[2] ? Number(phan[2]) : 30;
  if (!uid) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /mute [uid] [so_phut] (mặc định 30)." });
  if (!Number.isFinite(phut) || !Number.isInteger(phut) || phut <= 0) {
    return Response.json({ thanh_cong: false, text: "⚠️ Số phút không hợp lệ." });
  }
  if (!env.NHOM_CHAT) {
    return Response.json({ thanh_cong: false, text: "⚠️ Chưa cấu hình biến môi trường NHOM_CHAT trên Worker." });
  }
  const untilDate = Math.floor(Date.now() / 1000) + Math.max(phut * 60, 31);
  const kq = await telegramApi(env, "restrictChatMember", {
    chat_id: env.NHOM_CHAT,
    user_id: Number(uid),
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
    until_date: untilDate,
    });
    if (!kq || !kq.ok) {
    return Response.json({ thanh_cong: false, text: `❌ Không mute được. ${kq && kq.description ? kq.description : "Kiểm tra bot đã là admin nhóm, quyền Restrict members."}` });
  }
    return Response.json({ thanh_cong: true, text: `🔇 Đã mute UID ${uid} trong ${phut} phút (tới ${new Date(untilDate * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}).` });
    }
    case "/unmute": {
      const uid = phan[1];
      if (!uid) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /unmute [uid]." });
      if (!env.NHOM_CHAT) {
        return Response.json({ thanh_cong: false, text: "⚠️ Chưa cấu hình biến môi trường NHOM_CHAT trên Worker." });
      }
      const quyen = await layQuyenMacDinhNhom(env, env.NHOM_CHAT);
      const kq = await telegramApi(env, "restrictChatMember", {
        chat_id: env.NHOM_CHAT,
        user_id: Number(uid),
        permissions: quyen,
      });
      if (!kq || !kq.ok) {
        return Response.json({ thanh_cong: false, text: `❌ Không gỡ mute được. ${kq && kq.description ? kq.description : "Kiểm tra bot đã là admin nhóm, quyền Restrict members."}` });
      }
      return Response.json({ thanh_cong: true, text: `🔊 Đã gỡ mute cho UID ${uid}.` });
    }
    case "/ban": {
      const uid = phan[1];
      const phut = phan[2] ? Number(phan[2]) : 30;
      if (!uid) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /ban [uid] [so_phut] (mặc định 30)." });
      if (!Number.isFinite(phut) || !Number.isInteger(phut) || phut <= 0) {
      return Response.json({ thanh_cong: false, text: "⚠️ Số phút không hợp lệ." });
      }
      if (!env.NHOM_CHAT) {
      return Response.json({ thanh_cong: false, text: "⚠️ Chưa cấu hình biến môi trường NHOM_CHAT trên Worker." });
      }
      const untilDate = Math.floor(Date.now() / 1000) + Math.max(phut * 60, 31);
      const kq = await telegramApi(env, "banChatMember", { chat_id: env.NHOM_CHAT, user_id: Number(uid), until_date: untilDate });
      if (!kq || !kq.ok) {
      return Response.json({ thanh_cong: false, text: `❌ Không ban được. ${kq && kq.description ? kq.description : "Kiểm tra bot đã là admin nhóm, quyền Ban users."}` });
      }
      return Response.json({ thanh_cong: true, text: `🚫 Đã ban UID ${uid} trong ${phut} phút (tới ${new Date(untilDate * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}).` });
      }
      case "/unban": {
        const uid = phan[1];
        if (!uid) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /unban [uid]." });
        if (!env.NHOM_CHAT) {
          return Response.json({ thanh_cong: false, text: "⚠️ Chưa cấu hình biến môi trường NHOM_CHAT trên Worker." });
        }
        const kq = await telegramApi(env, "unbanChatMember", {
          chat_id: env.NHOM_CHAT,
          user_id: Number(uid),
          only_if_banned: true,
        });
        if (!kq || !kq.ok) {
          return Response.json({ thanh_cong: false, text: `❌ Không gỡ ban được. ${kq && kq.description ? kq.description : "Kiểm tra bot đã là admin nhóm, quyền Ban users."}` });
        }
        return Response.json({ thanh_cong: true, text: `✅ Đã gỡ ban cho UID ${uid}.` });
      }
      case "/check": {
        const uid = phan[1];
        if (!uid) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /check [ID_nguoi_dung]" });
        const nguoiDung = await layNguoiDung(env, uid);
        if (!nguoiDung) return Response.json({ thanh_cong: false, text: `❌ Không tìm thấy user ID: ${uid}` });

        const dd = await layDiemDanh(env, uid);
        const muaGiai = await layHoacTaoMuaGiai(env);
        const coinChoBXH = nguoiDung.tongDaKiem != null ? nguoiDung.tongDaKiem : nguoiDung.coin || 0;
        const mocMuaGiai = await damBaoMocMuaGiai(env, uid, nguoiDung, muaGiai.so);
        const daKiemTrongMua = Math.max(0, coinChoBXH - mocMuaGiai.coin_goc);

        const text =
          `👤 ID: ${uid} | Tên: ${nguoiDung.ten || "?"}\n` +
          `🪙 Coin: ${(nguoiDung.coin || 0).toLocaleString("vi-VN")}\n` +
          `📊 Tổng đã kiếm: ${(nguoiDung.tongDaKiem || 0).toLocaleString("vi-VN")}\n` +
          `⛏️ Cấp đào: ${nguoiDung.capDao || 1}/${CAP_DAO_TOI_DA}\n` +
          `🔥 Chuỗi điểm danh: ${dd.chuoi_hien_tai || 0} ngày\n` +
          `🏆 Đã kiếm trong mùa #${muaGiai.so}: ${daKiemTrongMua.toLocaleString("vi-VN")} xu\n` +
          `👤 Giới thiệu bởi: ${nguoiDung.gioiThieuBoi || "Không có"}`;
        return Response.json({ thanh_cong: true, text });
      }
      case "/sluser": {
        let tongSo = 0;
        for await (const _uid of duyetTatCaNguoiDung(env)) tongSo += 1;
        return Response.json({ thanh_cong: true, text: `👥 Tổng số user: ${tongSo.toLocaleString("vi-VN")}` });
      }
      case "/checknv": {
        const thongKe = await layThongKeNhiemVuNgay(env);
        const text = dinhDangThongKeNhiemVuNgay(thongKe);
        return Response.json({ thanh_cong: true, text });
      }
      case "/baotri": {
        const hanhDong = (phan[1] || "").toLowerCase();
        if (hanhDong === "bat" || hanhDong === "on") {
          await datCheDoBaoTri(env, true);
          return Response.json({ thanh_cong: true, text: "🛠️ Đã BẬT chế độ bảo trì." });
        }
        if (hanhDong === "tat" || hanhDong === "off") {
          await datCheDoBaoTri(env, false);
          return Response.json({ thanh_cong: true, text: "✅ Đã TẮT chế độ bảo trì." });
        }
        const dangBat = await dangBaoTri(env);
        return Response.json({
          thanh_cong: true,
          text: `ℹ️ Chế độ bảo trì hiện đang: ${dangBat ? "🛠️ BẬT" : "✅ TẮT"}\nDùng: /baotri bat hoặc /baotri tat`,
        });
      }
      case "/dsadmin": {
        const danhSach = await layDanhSachAdmin(env);
        return Response.json({
          thanh_cong: true,
          text: "👑 DANH SÁCH ADMIN:\n" + danhSach.map((ad, idx) => `${idx + 1}. ${ad}`).join("\n"),
        });
      }
      case "/tucam": {
        // Cú pháp giống hệt lệnh Telegram: /tucam [tu_khoa] | /tucam ds | /tucam xoa [tu_khoa]
        const hanhDongTho = (phan[1] || "").toLowerCase();

        if (!phan[1]) {
          return Response.json({
            thanh_cong: false,
            text:
              "⚠️ Dùng:\n" +
              "/tucam [tu_khoa] — thêm từ khóa cấm mới\n" +
              "/tucam ds — xem danh sách từ khóa cấm hiện tại\n" +
              "/tucam xoa [tu_khoa] — xóa 1 từ khóa cấm đã thêm",
          });
        }

        if (hanhDongTho === "ds") {
          const tuyChinh = await layTuKhoaCamTuyChinh(env);
          const text =
            `🚫 TỪ KHOÁ CẤM CỐ ĐỊNH (${DANH_SACH_TU_KHOA_CAM.length}):\n` +
            DANH_SACH_TU_KHOA_CAM.map((t, i) => `${i + 1}. ${t}`).join("\n") +
            `\n\n➕ TỪ KHOÁ CẤM TÙY CHỈNH (${tuyChinh.length}):\n` +
            (tuyChinh.length ? tuyChinh.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(chưa có)");
          return Response.json({ thanh_cong: true, text });
        }

        if (hanhDongTho === "xoa") {
          // `phan` tách từ `dong` gốc (chưa bị lowercase) nên giữ nguyên hoa/thường
          // của từ khóa cần xóa.
          const tuXoa = phan.slice(2).join(" ").trim();
          if (!tuXoa) {
            return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /tucam xoa [tu_khoa]" });
          }
          const tuyChinh = await layTuKhoaCamTuyChinh(env);
          const idx = tuyChinh.findIndex((t) => t.toLowerCase() === tuXoa.toLowerCase());
          if (idx === -1) {
            return Response.json({
              thanh_cong: false,
              text: `❌ Không tìm thấy "${tuXoa}" trong danh sách tùy chỉnh (chỉ xóa được từ đã thêm qua /tucam).`,
            });
          }
          tuyChinh.splice(idx, 1);
          await luuTuKhoaCamTuyChinh(env, tuyChinh);
          return Response.json({ thanh_cong: true, text: `✅ Đã xóa từ khóa cấm: "${tuXoa}"` });
        }

        // Mặc định: THÊM MỚI — lấy nguyên phần còn lại của tin nhắn GỐC (giữ hoa/
        // thường + khoảng trắng bên trong, vd "Trang Cá Nhân") sau "/tucam".
        const tuMoi = phan.slice(1).join(" ").trim();

        const toanBo = await layToanBoTuKhoaCam(env);
        if (toanBo.some((t) => t.toLowerCase() === tuMoi.toLowerCase())) {
          return Response.json({ thanh_cong: false, text: `⚠️ Từ khóa "${tuMoi}" đã có trong danh sách cấm rồi.` });
        }

        const tuyChinh = await layTuKhoaCamTuyChinh(env);
        tuyChinh.push(tuMoi);
        await luuTuKhoaCamTuyChinh(env, tuyChinh);

        return Response.json({
          thanh_cong: true,
          text: `✅ Đã thêm từ khóa cấm: "${tuMoi}"\nTừ giờ tin nhắn trong nhóm chứa từ này (khớp nguyên từ) sẽ tự động bị xóa.`,
        });
      }
      case "/tucam18": {
        // Cú pháp giống hệt lệnh Telegram: /tucam18 [tu_khoa] | /tucam18 ds | /tucam18 xoa [tu_khoa]
        const hanhDongTho = (phan[1] || "").toLowerCase();

        if (!phan[1]) {
          return Response.json({
            thanh_cong: false,
            text:
              "⚠️ Dùng:\n" +
              "/tucam18 [tu_khoa] — thêm từ khóa 18+ mới (tự bắt biến thể không dấu/chèn ký tự/teencode/lặp chữ)\n" +
              "/tucam18 ds — xem danh sách từ khóa 18+ hiện tại\n" +
              "/tucam18 xoa [tu_khoa] — xóa 1 từ khóa 18+ đã thêm",
          });
        }

        if (hanhDongTho === "ds") {
          const danhSach = await layTuKhoa18(env);
          const text =
            `🔞 TỪ KHOÁ 18+ ĐANG LỌC (${danhSach.length}):\n` +
            (danhSach.length ? danhSach.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(chưa cấu hình từ khoá nào)");
          return Response.json({ thanh_cong: true, text });
        }

        if (hanhDongTho === "xoa") {
          const tuXoa = phan.slice(2).join(" ").trim();
          if (!tuXoa) {
            return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /tucam18 xoa [tu_khoa]" });
          }
          const danhSach = await layTuKhoa18(env);
          const idx = danhSach.findIndex((t) => t.toLowerCase() === tuXoa.toLowerCase());
          if (idx === -1) {
            return Response.json({ thanh_cong: false, text: `❌ Không tìm thấy "${tuXoa}" trong danh sách 18+.` });
          }
          danhSach.splice(idx, 1);
          await luuTuKhoa18(env, danhSach);
          return Response.json({ thanh_cong: true, text: `✅ Đã xóa từ khoá 18+: "${tuXoa}"` });
        }

        const tuMoi = phan.slice(1).join(" ").trim();
        const danhSach = await layTuKhoa18(env);
        if (danhSach.some((t) => t.toLowerCase() === tuMoi.toLowerCase())) {
          return Response.json({ thanh_cong: false, text: `⚠️ Từ khoá "${tuMoi}" đã có trong danh sách 18+ rồi.` });
        }
        danhSach.push(tuMoi);
        await luuTuKhoa18(env, danhSach);

        return Response.json({
          thanh_cong: true,
          text: `✅ Đã thêm từ khoá 18+: "${tuMoi}"\nTin nhắn (kể cả chữ trong ảnh) chứa cụm này hoặc biến thể né lọc của nó sẽ tự động bị xoá.`,
        });
      }
      case "/taogifcode": {
        // Cú pháp giống hệt lệnh Telegram: /taogifcode [so_coin hoặc min-max] [code] [so_luong] [veN] [loi_nhan]
        // veN (VD "ve5") TÙY CHỌN — tặng kèm N vé quay mỗi lượt nhập mã.
        // Dùng `dong` (chuỗi GỐC, chưa lowercase) để giữ nguyên hoa/thường +
        // khoảng trắng của loi_nhan (tham số cuối, có thể chứa emoji/dấu cách).
        const khop = dong.match(/^\S+\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(ve\d+))?(?:\s+([\s\S]+))?$/i);
        if (!khop) {
          return Response.json({
            thanh_cong: false,
            text:
              "⚠️ Dùng: /taogifcode [so_coin hoặc min-max] [code] [so_luong] [veN (tuỳ chọn)] [loi_nhan]\n" +
              "VD số cố định: /taogifcode 5000 TET2026 100\n" +
              "VD khoảng random: /taogifcode 4000-5000 TET2026 100\n" +
              "VD kèm vé quay: /taogifcode 4000-5000 TET2026 100 ve5\n" +
              "VD kèm vé quay + lời nhắn riêng: /taogifcode 4000-5000 TET2026 100 ve5 🧧 GIFT CODE TẾT 2026!",
          });
        }

        const khoangCoin = phanTichKhoangCoin(khop[1]);
        const maGoc = khop[2];
        const soLuong = Number(khop[3]);
        const veQuayThuong = khop[4] ? Number(khop[4].slice(2)) : 0;
        const loiNhan = khop[5] ? khop[5].trim() : null;

        if (!khoangCoin) {
          return Response.json({ thanh_cong: false, text: "⚠️ Số coin không hợp lệ. Dùng 1 số dương (VD: 5000) hoặc 1 khoảng min-max (VD: 4000-5000)." });
        }
        if (!Number.isFinite(soLuong) || !Number.isInteger(soLuong) || soLuong <= 0) {
          return Response.json({ thanh_cong: false, text: "⚠️ Số lượt nhập phải là số nguyên dương." });
        }

        const ma = maGoc.toUpperCase();
        if (!/^[A-Z0-9_]{3,30}$/.test(ma)) {
          return Response.json({ thanh_cong: false, text: "⚠️ Mã code chỉ gồm chữ, số, gạch dưới, dài 3-30 ký tự (không dùng dấu \"-\")." });
        }

        const daTonTai = await env.USERS.get(TIEN_TO_GIFCODE + ma);
        if (daTonTai) {
          return Response.json({ thanh_cong: false, text: `❌ Mã "${ma}" đã tồn tại rồi, chọn mã khác.` });
        }

        const giftcodeMoi = {
          code: ma,
          coinMin: khoangCoin.min,
          coinMax: khoangCoin.max,
          veQuayThuong,
          soLuongToiDa: soLuong,
          soLuongDaDung: 0,
          taoLuc: Date.now(),
          taoBoi: "web-admin",
          loiNhan,
        };
        await env.USERS.put(TIEN_TO_GIFCODE + ma, JSON.stringify(giftcodeMoi));

        const dongThuong =
          khoangCoin.min === khoangCoin.max
            ? `${khoangCoin.min.toLocaleString("vi-VN")} coin/lượt`
            : `${khoangCoin.min.toLocaleString("vi-VN")} - ${khoangCoin.max.toLocaleString("vi-VN")} coin/lượt (ngẫu nhiên)`;
        const dongVeQuayXacNhanWeb = veQuayThuong > 0 ? `\n🎫 Vé quay/lượt: ${veQuayThuong.toLocaleString("vi-VN")}` : "";

        // Gửi thông báo vào NHÓM TRÒ CHUYỆN, giống hệt lệnh Telegram /taogifcode.
        let dongKetQuaGui = "⚠️ Chưa gửi được thông báo — chưa cấu hình biến môi trường NHOM_CHAT trên Worker.";
        if (env.NHOM_CHAT) {
          const tinNhan = xayDungTinGifcode(giftcodeMoi, loiNhan);
          const linkBot = env.LINK_BOT || "https://t.me/vuacaytien_bot";
          try {
            const kq = await telegramApi(env, "sendMessage", {
              chat_id: env.NHOM_CHAT,
              text: tinNhan,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🎁 Nhập ngay", url: linkBot }]] },
            });
            dongKetQuaGui = kq && kq.ok ? "📣 Đã gửi thông báo vào nhóm trò chuyện." : "❌ Gửi thông báo vào nhóm thất bại.";
          } catch (e) {
            dongKetQuaGui = `❌ Lỗi khi gửi thông báo: ${String(e)}`;
          }
        }

        const text =
          `✅ Đã tạo gift code!\n\n` +
          `🎁 Mã: ${ma}\n` +
          `🪙 Thưởng: ${dongThuong}${dongVeQuayXacNhanWeb}\n` +
          `👥 Số lượt tối đa: ${soLuong.toLocaleString("vi-VN")}\n\n` +
          dongKetQuaGui;
        return Response.json({ thanh_cong: true, text });
      }
      case "/xoagiftcodedayluot": {
        // Xóa VĨNH VIỄN các gift code đã dùng hết lượt (soLuongDaDung >=
        // soLuongToiDa) — giúp /checkcode và mọi thao tác list(prefix:
        // "gifcode:") sau này đọc ít dòng hơn khi số mã tích lũy lên tới
        // hàng nghìn (mỗi mã cũ hết lượt không còn tác dụng gì nữa, chỉ
        // tổ làm dài thêm danh sách phải quét). Bắt buộc gõ thêm "xacnhan"
        // để tránh xóa nhầm qua thao tác bấm nhanh/gợi ý lệnh.
        if ((phan[1] || "").toLowerCase() !== "xacnhan") {
          return Response.json({
            thanh_cong: false,
            text:
              "⚠️ Đây là thao tác XÓA VĨNH VIỄN các gift code đã hết lượt nhập, không thể hoàn tác.\n" +
              "Gõ: /xoagiftcodedayluot xacnhan để tiếp tục.",
          });
        }

        let daXoa = 0;
        let daGiu = 0;
        let cursor;
        for (;;) {
          const trang = await env.USERS.list({ prefix: TIEN_TO_GIFCODE, cursor });
          for (const key of trang.keys) {
            const raw = await env.USERS.get(key.name);
            if (!raw) continue;
            let gc;
            try {
              gc = JSON.parse(raw);
            } catch (e) {
              continue; // dữ liệu hỏng, bỏ qua
            }
            if ((gc.soLuongDaDung || 0) >= (gc.soLuongToiDa || 0)) {
              await env.USERS.delete(key.name);
              daXoa += 1;
            } else {
              daGiu += 1;
            }
          }
          if (trang.list_complete) break;
          cursor = trang.cursor;
        }

        const text =
          `🧹 Đã xóa ${daXoa.toLocaleString("vi-VN")} gift code đã hết lượt nhập.\n` +
          `📦 Còn giữ lại ${daGiu.toLocaleString("vi-VN")} mã chưa hết lượt.\n\n` +
          `ℹ️ Lưu ý: các bản ghi "đã nhập mã" của từng user (gifcode-da-dung:*) KHÔNG bị xóa — chúng không nằm trong bất kỳ vòng quét list() nào khác nên không tốn thêm read, giữ lại để không lỡ cho phép user nhập lại mã cũ nếu admin tạo lại đúng mã đó sau này.`;
        return Response.json({ thanh_cong: true, text });
      }
      case "/checkcode": {
        const danhSachMa = [];
        let cursor;
        for (;;) {
          const trang = await env.USERS.list({ prefix: TIEN_TO_GIFCODE, cursor });
          for (const key of trang.keys) danhSachMa.push(key.name.slice(TIEN_TO_GIFCODE.length));
          if (trang.list_complete) break;
          cursor = trang.cursor;
        }
        const chiTiet = [];
        for (const ma of danhSachMa) {
          const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
          if (raw) chiTiet.push(JSON.parse(raw));
        }
        chiTiet.sort((a, b) => b.taoLuc - a.taoLuc);
        const dong2 = chiTiet.slice(0, 30).map((gc, idx) => `${idx + 1}. ${gc.code} | ${gc.soLuongDaDung}/${gc.soLuongToiDa} lượt`);
        return Response.json({ thanh_cong: true, text: chiTiet.length ? dong2.join("\n") : "📭 Chưa có gift code nào." });
      }
      case "/checkcodesl": {
        const ma = (phan[1] || "").toUpperCase();
        if (!ma) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /checkcodesl [code]" });
        const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
        if (!raw) return Response.json({ thanh_cong: false, text: `❌ Mã "${ma}" không tồn tại.` });
        const gc = JSON.parse(raw);
        return Response.json({ thanh_cong: true, text: `🎁 Mã: ${gc.code}\n👥 Đã dùng: ${gc.soLuongDaDung}/${gc.soLuongToiDa}` });
      }
      case "/xoacode": {
        const ma = (phan[1] || "").toUpperCase();
        if (!ma) return Response.json({ thanh_cong: false, text: "⚠️ Dùng: /xoacode [code]" });
        const raw = await env.USERS.get(TIEN_TO_GIFCODE + ma);
        if (!raw) return Response.json({ thanh_cong: false, text: `❌ Mã "${ma}" không tồn tại.` });
        const gc = JSON.parse(raw);
        await env.USERS.delete(TIEN_TO_GIFCODE + ma);
        return Response.json({
          thanh_cong: true,
          text: `✅ Đã xóa gift code "${ma}" (đã dùng ${gc.soLuongDaDung}/${gc.soLuongToiDa} lượt). 🚫 Mã sẽ không còn hoạt động được nữa, kể cả khi chưa hết lượt nhập.`,
        });
      }
      case "/dslenh": {
        const text =
          "🛠️ LỆNH HỖ TRỢ TRÊN WEB:\n" +
          "/check [ID] — xem thông tin 1 người chơi\n" +
          "/sluser — tổng số user\n" +
          "/checknv — thống kê nhiệm vụ theo từng ngày (7 ngày gần nhất)\n" +
          "/baotri [bat|tat] — bật/tắt/xem chế độ bảo trì\n" +
          "/tucam [tu_khoa] — thêm từ khóa cấm để bot tự xóa tin trong nhóm. /tucam ds xem danh sách, /tucam xoa [tu_khoa] để xóa\n" +
          "/tucam18 [tu_khoa] — thêm từ khóa 18+ để bot tự xóa tin (kể cả chữ trong ảnh), tự bắt biến thể không dấu/chèn ký tự/teencode/lặp chữ. /tucam18 ds, /tucam18 xoa [tu_khoa]\n" +
          "/mute [uid] [so_phut] — tắt quyền gửi tin của 1 UID trong nhóm (mặc định 30 phút)\n" +
          "/unmute [uid] — gỡ mute sớm cho 1 UID, không cần chờ hết hạn\n" +
          "/ban [uid] [so_phut] — cấm 1 UID vào nhóm (mặc định 30 phút)\n" +
          "/unban [uid] — gỡ ban sớm cho 1 UID, cho vào lại nhóm ngay qua link mời\n" +
          "/dsadmin — danh sách admin\n" +
          "/taogifcode [coin hoặc min-max] [code] [so_luong] [veN] [loi_nhan] — tạo gift code mới, veN (VD ve5) tuỳ chọn tặng kèm vé quay, tự thông báo vào nhóm\n" +
          "/checkcode — danh sách gift code\n" +
          "/checkcodesl [code] — chi tiết 1 gift code\n" +
          "/xoacode [code] — xóa vĩnh viễn 1 gift code kể cả khi chưa hết lượt\n" +
          "/xoagiftcodedayluot xacnhan — xóa các gift code đã hết lượt (giảm tải khi có hàng nghìn mã)";
        return Response.json({ thanh_cong: true, text });
      }
      default:
        return Response.json({ thanh_cong: false, text: `❌ Lệnh "${lenh}" không hỗ trợ trên web. Dùng /dslenh để xem danh sách.` });
    }
  } catch (e) {
    return Response.json({ thanh_cong: false, text: `❌ Lỗi: ${String(e)}` }, { status: 500 });
  }
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

    // Web admin quản lý người chơi + ô lệnh — xác thực bằng header X-Admin-Secret
    if (request.method === "GET" && url.pathname === "/admin/nguoi-choi/danh-sach") {
      return xuLyDanhSachNguoiChoiAdmin(env, request, url);
    }
    if (request.method === "POST" && url.pathname === "/admin/nguoi-choi/sua") {
      return xuLySuaNguoiChoiAdmin(env, request);
    }
    if (request.method === "POST" && url.pathname === "/admin/lenh") {
      return xuLyLenhAdminWeb(env, request);
    }

    // 🛠️ Chế độ bảo trì — nếu đang BẬT (bật/tắt qua lệnh Telegram /baotri,
    // xem xuLyBaoTri), chặn TOÀN BỘ request còn lại (cả trang miniapp lẫn
    // mọi API), CHỈ trừ trang quản lý rút tiền + quản lý người chơi (để
    // admin vẫn thao tác được) và /suc-khoe (để hệ thống giám sát uptime
    // không báo động nhầm).
    if (
      url.pathname !== "/admin/rut-tien/danh-sach" &&
      url.pathname !== "/admin/nguoi-choi/danh-sach" &&
      url.pathname !== "/admin/nguoi-choi/sua" &&
      url.pathname !== "/admin/lenh" &&
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
      if (url.pathname.startsWith("/nvtp/")) {
        const ma = url.pathname.slice("/nvtp/".length);
        return xuLyTrangNhiemVuTP(env, ma);
      }
      if (url.pathname.startsWith("/nvbb/")) {
        const ma = url.pathname.slice("/nvbb/".length);
        return xuLyTrangNhiemVuBB(env, ma);
      }
      if (url.pathname.startsWith("/nvlm/")) {
        const ma = url.pathname.slice("/nvlm/".length);
        return xuLyTrangNhiemVuLM(env, ma);
      }

      // 🔐 Bắt buộc initData THẬT cho mọi endpoint dữ liệu cá nhân — ghi
      // đè uid client gửi (nếu có) bằng uid ĐÃ XÁC THỰC từ chữ ký Telegram,
      // để không handler nào bên dưới còn tin được uid do client tự khai.
      if (DUONG_DAN_CAN_XAC_THUC_INIT_DATA.has(url.pathname)) {
        const xacThuc = await xacThucInitData(env.BOT_TOKEN, request.headers.get("X-Telegram-Init-Data") || "");
        if (!xacThuc) return Response.json({ thanh_cong: false, loi: "chua_xac_thuc" }, { status: 401 });
        url.searchParams.set("uid", xacThuc.uid);
      }

      switch (url.pathname) {
        case "/kiem-tra-thanh-vien":
          return xuLyKiemTraThanhVien(env, url);
        case "/tao-nhiem-vu":
          return xuLyTaoNhiemVu(env, url, url.origin);
        case "/nhiem-vu-hien-tai":
          return xuLyNhiemVuHienTai(env, url);
        case "/reset-nhiem-vu":
          return xuLyResetNhiemVu(env, url);
        case "/xac-nhan-nhiem-vu":
          return xuLyXacNhanNhiemVu(env, url);
        case "/tao-nhiem-vu-tp":
          return xuLyTaoNhiemVuTP(env, url, url.origin);
        case "/nhiem-vu-hien-tai-tp":
          return xuLyNhiemVuHienTaiTP(env, url);
        case "/reset-nhiem-vu-tp":
          return xuLyResetNhiemVuTP(env, url);
        case "/xac-nhan-nhiem-vu-tp":
          return xuLyXacNhanNhiemVuTP(env, url);
        case "/tao-nhiem-vu-bb":
          return xuLyTaoNhiemVuBB(env, url, url.origin);
        case "/nhiem-vu-hien-tai-bb":
          return xuLyNhiemVuHienTaiBB(env, url);
        case "/reset-nhiem-vu-bb":
          return xuLyResetNhiemVuBB(env, url);
        case "/xac-nhan-nhiem-vu-bb":
          return xuLyXacNhanNhiemVuBB(env, url);
        case "/tao-nhiem-vu-lm":
          return xuLyTaoNhiemVuLM(env, url, url.origin);
        case "/nhiem-vu-hien-tai-lm":
          return xuLyNhiemVuHienTaiLM(env, url);
        case "/reset-nhiem-vu-lm":
          return xuLyResetNhiemVuLM(env, url);
        case "/xac-nhan-nhiem-vu-lm":
          return xuLyXacNhanNhiemVuLM(env, url);
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
        case "/shop-thong-tin":
          return xuLyShopThongTin(env, url);
        case "/shop-mua":
          return xuLyShopMua(env, url);
        case "/lam-them-thong-tin":
          return xuLyLamThemThongTin(env, url);
        case "/quay-thuong":
          return xuLyQuayThuong(env, url);
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
  //   "*/10 * * * *" (mỗi 10 phút)  → kiểm tra + tự động trao thưởng mùa
  //                                 giải vừa kết thúc (nếu có), rồi làm
  //                                 mới cache bảng xếp hạng
  //   "0 14 * * *"   (14:00 UTC = 21:00 giờ VN mỗi ngày) → tự tạo gift code
  //                                 300-500 coin, 50 lượt nhập
  // Phân biệt bằng event.cron để mỗi lịch chỉ chạy đúng việc của nó.
  async scheduled(event, envGoc, ctx) {
    const env = boQuaD1(envGoc);
    if (event.cron === "0 14 * * *") {
      ctx.waitUntil(taoGifcodeTuDong(env));
    } else {
      ctx.waitUntil(
        (async () => {
          await traoThuongMuaGiaiDaKetThucNeuCo(env);
          await lamMoiCacheBangXepHang(env);
        })()
      );
    }
  },
};
