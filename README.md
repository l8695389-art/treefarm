# Đào Đá Quý — Telegram Mini App (Cloudflare Workers + D1)

Game tap-to-earn, dữ liệu người chơi lưu trong Cloudflare D1 (SQLite),
phục vụ qua Cloudflare Workers (kèm static assets, không cần build step).

## Cấu trúc

```
crystal-tap-game/
├── wrangler.toml          # cấu hình Worker + D1 + static assets
├── migrations/
│   └── 0001_init.sql      # schema bảng players
├── src/
│   └── worker.js          # API: /api/player, /api/leaderboard
└── public/
    ├── index.html          # giao diện game
    └── app.js              # logic game (vanilla JS, gọi API)
```

## Triển khai

### 1. Cài Wrangler và đăng nhập

```bash
npm install -g wrangler
wrangler login
```

### 2. Tạo database D1

```bash
cd crystal-tap-game
wrangler d1 create crystal_tap_db
```

Lệnh trên trả về một `database_id` — copy giá trị đó vào `wrangler.toml`,
thay cho `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 3. Chạy migration để tạo bảng

```bash
# kiểm tra local trước
wrangler d1 execute crystal_tap_db --local --file=./migrations/0001_init.sql

# áp dụng lên database thật
wrangler d1 execute crystal_tap_db --remote --file=./migrations/0001_init.sql
```

Nếu database đã tồn tại từ trước khi có gem/cấp đào/mời bạn, chạy thêm:

```bash
wrangler d1 execute crystal_tap_db --remote --file=./migrations/0003_gems_level_referral.sql
```

Nếu database đã tồn tại từ trước khi có tính năng xem quảng cáo, chạy thêm:

```bash
wrangler d1 execute crystal_tap_db --remote --file=./migrations/0004_ad_rewards.sql
```

*(Cài mới hoàn toàn thì bỏ qua 2 bước trên — `0001_init.sql` đã có sẵn đủ cột.)*

### 4. (Khuyến nghị) Bật xác thực dữ liệu Telegram

Lấy bot token từ [@BotFather](https://t.me/BotFather), rồi:

```bash
wrangler secret put BOT_TOKEN
```

Nếu bỏ qua bước này, app vẫn chạy bình thường nhưng server sẽ không xác minh
request thực sự đến từ Telegram (phù hợp khi test, không khuyến nghị cho production).

### 5. Deploy

```bash
wrangler deploy
```

Wrangler sẽ in ra URL dạng `https://crystal-tap-game.<subdomain>.workers.dev`.

### 6. Đăng ký Mini App với BotFather

Trong Telegram, chat với **@BotFather**:

1. `/newapp` (hoặc `/setmenubutton` nếu bot đã tồn tại)
2. Chọn bot của bạn
3. Nhập URL Worker vừa deploy ở bước 5 làm **Web App URL**

Mở bot trên Telegram và bấm nút Mini App để chơi thử.

### 7. Bật trả lời tự động khi người dùng gõ /start

Bot sẽ tự trả lời chào mừng kèm nút "Chơi ngay" mỗi khi ai đó bấm **Start**
hoặc gõ `/start` trong chat với bot.

1. Điền đúng URL Worker vào `MINI_APP_URL` trong `wrangler.toml`, rồi deploy lại:
   ```bash
   wrangler deploy
   ```
2. Đảm bảo đã set `BOT_TOKEN` (bước 4) — bot cần token này để gửi tin nhắn.
3. Đăng ký webhook để Telegram gửi các cập nhật (bao gồm /start) tới Worker:
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://<worker-url>/webhook" \
     -d "secret_token=<WEBHOOK_SECRET nếu bạn có đặt>"
   ```
4. Kiểm tra webhook đã đăng ký đúng:
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
   ```

Từ giờ, mở chat với bot và gõ `/start` sẽ nhận được tin nhắn chào mừng kèm
nút bấm mở thẳng Mini App.

Muốn thêm lệnh khác (`/help`, `/leaderboard`...), sửa hàm `handleTelegramUpdate`
trong `src/worker.js`.

### 8. Cấu hình link mời bạn (tab Bạn bè)

Link mời bạn dùng định dạng "direct link" của Telegram Mini App:
`https://t.me/<bot_username>/<app_short_name>?startapp=ref_<uid>` — khi người
được mời mở link này, Telegram tự đưa `ref_<uid>` vào `initDataUnsafe.start_param`
để app đọc và đăng ký giới thiệu.

1. Lấy **username bot** (không có `@`) và **short name** của Mini App —
   short name được đặt lúc chạy `/newapp` với BotFather (hoặc xem lại qua
   `/myapps` nếu quên).
2. Điền vào `wrangler.toml`:
   ```toml
   BOT_USERNAME = "ten_bot_cua_ban"
   APP_SHORT_NAME = "ten_ngan_cua_app"
   ```
3. Deploy lại:
   ```bash
   wrangler deploy
   ```

Nếu bỏ trống 2 biến này, tab Bạn bè vẫn hoạt động nhưng sẽ báo "Chưa cấu
hình" thay vì hiển thị link thật.

## Local dev

```bash
wrangler dev
```

Mở `http://localhost:8787` — khi chạy ngoài Telegram, app tự tạo một ID
ẩn danh lưu trong `localStorage` của trình duyệt để bạn test được.

## Chỉ mở được trong Telegram

App kiểm tra `Telegram.WebApp.initData` khi tải trang. Nếu mở trực tiếp bằng
trình duyệt thường (không có `initData` hợp lệ), app sẽ hiện màn "Chỉ mở
được trong Telegram" và không gọi bất kỳ API nào.

Ngoại lệ: khi chạy trên `localhost`/`127.0.0.1` (tức là đang `wrangler dev`
để phát triển), app vẫn cho phép mở để tiện test — lúc đó sẽ dùng ID ẩn danh
lưu trong `localStorage` và hỏi nhập tên thủ công như trước.

## Danh tính người chơi

Khi mở trong Telegram, app tự lấy thông tin từ `Telegram.WebApp.initDataUnsafe.user`,
không cần người chơi tự nhập:

- **Ảnh đại diện**: dùng đúng `photo_url` Telegram trả về; nếu không có, hiện
  chữ cái đầu tên làm avatar thay thế.
- **Tên hiển thị**: ưu tiên tên hiển thị Telegram (họ + tên); nếu tài khoản
  không có tên thì dùng `@username`; nếu có cả hai đều thiếu (hiếm), app sẽ
  hỏi nhập tên thủ công.
- Tên/ảnh được đồng bộ lại mỗi lần mở app, để nếu người chơi đổi tên hoặc
  ảnh trên Telegram thì dữ liệu trong game cũng cập nhật theo.
- Khi test ngoài Telegram (mở thẳng bằng trình duyệt), app không có dữ liệu
  Telegram nên sẽ hỏi nhập tên thủ công và không có ảnh đại diện.

Nếu đã từng chạy migration `0001_init.sql` trước khi có 2 cột này, chạy thêm:

```bash
wrangler d1 execute crystal_tap_db --remote --file=./migrations/0002_add_avatar.sql
```

Cài mới hoàn toàn thì chỉ cần chạy `0001_init.sql` (đã có sẵn 2 cột này).

## Cơ chế đồng bộ dữ liệu

- Toàn bộ state của người chơi (xu, gem, năng lượng, cấp đào, chuỗi điểm danh,
  nhiệm vụ đã nhận, mời bạn...) được lưu trong bảng `players` của D1, khoá
  theo Telegram user ID.
- Năng lượng hồi theo thời gian thực: server tính lại phần hồi khi offline
  dựa trên `last_energy_ts` mỗi khi client gọi `GET /api/player`.
- Bảng xếp hạng lấy trực tiếp từ D1 (`ORDER BY coins DESC LIMIT 10`),
  không cần bảng riêng.
- Ghi dữ liệu được debounce ở client (500ms sau lần thay đổi cuối) để giảm
  số lần gọi API.

## Các hệ thống mới

### Gem & Shop (đổi Gem)
- Tỉ lệ quy đổi cố định: **100.000 coin = 1 gem**.
- Ô nhập ở tab Shop chỉ chấp nhận bội số của 100.000 (validate cả client
  lẫn server ở endpoint `POST /api/gem-exchange`).
- Lịch sử đổi gem (tối đa 20 lượt gần nhất) lưu trong cột `gem_exchange_log`,
  hiển thị lại ở tab Ví.

### Cấp độ đào (tab Đào)
- Tối đa **cấp 20**. Cấp 1 → 2 cần 500 XP, mỗi cấp sau đó cần thêm 300 XP
  so với cấp trước (cấp 2→3: 800 XP, cấp 3→4: 1.100 XP...).
- Mỗi lần chạm được +10 XP; cấp càng cao, mỗi lần chạm nhận thêm +5% coin
  (cấp 20 = +95% so với cấp 1).
- Cấp độ được validate/giới hạn (clamp 1-20) ở server khi lưu, nhưng XP
  tích luỹ vẫn do client tính (giống mô hình tin cậy client đang dùng cho
  coin/energy — xem mục "Nâng cấp gợi ý" bên dưới nếu cần chống gian lận
  chặt hơn).

### Mời bạn bè (tab Bạn bè)
- Link mời: `https://t.me/<bot>/<app>?startapp=ref_<uid>` (xem bước 8 ở trên).
- Khi người được mời mở app **lần đầu tiên**, server:
  1. Đọc `ref_<uid>` từ `start_param`.
  2. **Kiểm tra uid người mời có thật sự tồn tại trong DB không** trước khi
     cộng thưởng (chặn giả mạo link với uid bịa).
  3. Cộng ngay **1.000 coin** cho người mời, +1 vào số bạn đã mời.
- Sau đó, mỗi khi người được mời kiếm thêm coin (qua bất kỳ hoạt động nào),
  server tự động cộng **4% hoa hồng** số coin đó cho người mời — tính trên
  server bằng cách so sánh coin cũ/mới mỗi lần lưu, không cần client tự
  khai báo hoa hồng.
- Mốc thưởng mời bạn — người mời tự bấm "Nhận" khi đã đạt mốc (giống cơ chế
  nhiệm vụ):

  | Số bạn mời | Thưởng |
  |---|---|
  | 5 | 5.000 coin + 5 gem |
  | 10 | 12.000 coin + 12 gem |
  | 20 | 30.000 coin + 30 gem |
  | 50 | 100.000 coin + 100 gem |

  Chỉnh số liệu này trong `REFERRAL_MILESTONES` (cả `src/worker.js` lẫn
  `public/app.js`, phải sửa đồng bộ cả 2 file).

### Ví (tab Ví)
- Tổng quan số dư coin/gem, thống kê nhanh (lần chạm, chuỗi điểm danh, số
  bạn mời, hoa hồng đã nhận) và lịch sử đổi gem gần nhất.

### Xem quảng cáo nhận năng lượng (tab Đào)
- Dùng Monetag rewarded interstitial (`show_11524128()`), zone ID đã gắn sẵn
  trong `public/index.html`. Đổi zone ID khác thì sửa cả 2 chỗ: script tag
  `data-zone` trong `index.html` và hằng số `AD_ZONE_ID` trong `app.js`.
- Mỗi lượt xem thành công: **+20 năng lượng** (không vượt quá tối đa 500).
- Giới hạn **10 lượt/ngày** (reset theo giờ Việt Nam 00:00), **cách nhau tối
  thiểu 15 phút** giữa 2 lượt.
- Toàn bộ giới hạn/cooldown được **xác thực ở server** (`POST /api/watch-ad`)
  — client chỉ gọi Monetag SDK để hiển thị quảng cáo, sau đó server mới là
  nơi quyết định có cộng thưởng hay không, tránh trường hợp ai đó tự gọi
  thẳng hàm JS để cộng năng lượng khống.

## Bảo mật

Các endpoint ghi dữ liệu nhạy cảm (`/api/player`, `/api/gem-exchange`,
`/api/referral/claim-milestone`) đều kiểm tra `uid` gửi lên khớp với uid đã
ký trong `initData` Telegram — **chỉ hoạt động khi đã set `BOT_TOKEN`**
(bước 4). Nếu bỏ qua bước này, server tin theo uid client tự khai (chỉ nên
dùng khi phát triển/test cục bộ).

## Nâng cấp gợi ý

- Thêm rate-limit ở endpoint `/api/player` (Cloudflare Rate Limiting) để
  chống spam tap từ client bị chỉnh sửa.
- Thêm bảng `taps_log` nếu cần chống gian lận nghiêm ngặt hơn (xác thực số
  lần tap tối đa theo thời gian ở phía server thay vì tin client).
- Dùng Durable Objects thay D1 nếu cần state realtime nhiều người chơi cùng lúc.
