# Tree Farm Bot — Cloudflare Workers

Bot Telegram + Miniapp gộp chung một Worker duy nhất. Không còn polling, không
còn file JSON local — dùng webhook + KV + Durable Object.

## Những gì đã đổi so với bản Python

| Bản gốc (Python/Flask) | Bản Workers |
|---|---|
| `bot.polling()` | Webhook Telegram gọi thẳng Worker |
| `FILE_ADMIN` (json) | KV namespace `ADMINS` |
| `FILE_NGUOI_DUNG` (json) | KV namespace `USERS` |
| `FILE_IP` + `threading.Lock` | Durable Object `IpRegistry` (atomic tự nhiên) |
| `FILE_LOG` (txt local) | Bỏ — nhóm log Telegram đã là log tập trung |
| Flask routes | `fetch()` router trong `src/index.js` |
| `index.html` gọi domain Railway | Cùng origin với Worker, không cần domain ngoài |

## Cài đặt

```bash
npm install -g wrangler
cd treefarm-worker
npx wrangler login
```

## 1. Tạo KV namespaces

```bash
npx wrangler kv namespace create ADMINS
npx wrangler kv namespace create USERS
```

Copy `id` in ra từ mỗi lệnh, dán vào `wrangler.toml` (thay
`REPLACE_WITH_ADMINS_KV_ID` và `REPLACE_WITH_USERS_KV_ID`).

## 2. Set secrets

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put LINK4M_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET   # tự nghĩ 1 chuỗi random dài, vd: openssl rand -hex 32
```

## 3. Deploy

```bash
npx wrangler deploy
```

Sẽ ra domain dạng `https://treefarm-bot.<subdomain>.workers.dev`.

## 4. Đăng ký webhook với Telegram

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://treefarm-bot.<subdomain>.workers.dev/webhook/<WEBHOOK_SECRET>" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

`<WEBHOOK_SECRET>` dùng đúng giá trị đã set ở bước 2 — nó vừa nằm trong URL
vừa được Telegram gửi lại qua header để Worker xác thực từng request.

Kiểm tra webhook đã nhận đúng:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## 5. Cập nhật LINK_MINIAPP nếu cần

`wrangler.toml` đang để `LINK_MINIAPP = "https://m.treefarmapp.workers.dev/"`.
Nếu miniapp (`public/index.html`) và bot dùng chung domain vừa deploy ở bước 3,
đổi giá trị này thành domain đó rồi deploy lại.

## Test nhanh

- Nhắn `/start` cho bot trên Telegram → phải nhận được ảnh + nút mở miniapp
- Mở miniapp → mở DevTools → gọi `/tao-link` không còn lỗi CORS (vì cùng origin)
- `curl https://treefarm-bot.<subdomain>.workers.dev/suc-khoe` → `{"trang_thai":"on"}`

## Giới hạn cần biết

- **KV eventual consistency**: `ADMINS`/`USERS` có độ trễ lan truyền ~60s giữa
  các region. Không ảnh hưởng logic hiện tại (không có race condition thật sự
  ở 2 namespace này), nhưng nếu sau này cần đọc-ngay-sau-ghi cross-region thì
  cân nhắc chuyển sang D1.
- **Durable Object `IpRegistry`** dùng 1 instance global (`idFromName("global")`)
  — mọi request check/release IP đi qua cùng 1 instance nên tuần tự, đúng
  hành vi `threading.Lock` bản gốc. Nếu traffic tăng mạnh và IP check trở
  thành bottleneck, có thể shard theo IP prefix sau.
- **Broadcast `/gui`**: giữ delay 50ms/tin nhắn giống bản gốc để né rate-limit
  Telegram. Với danh sách user rất lớn (chục nghìn+), nên chuyển sang Cloudflare
  Queues để tránh giới hạn CPU time của 1 request Worker.
