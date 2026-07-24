// ==================================================
// IpRegistry — Durable Object thay cho khoa_ip (threading.Lock)
// + FILE_IP (json). Mỗi instance DO xử lý request tuần tự,
// nên không cần lock thủ công — race condition không thể xảy ra.
// ==================================================
export class IpRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ipDangDung = null; // cache trong bộ nhớ, nạp lười từ storage
  }

  async taiDuLieu() {
    if (this.ipDangDung === null) {
      const luuTru = await this.state.storage.get("ip_dang_dung");
      this.ipDangDung = luuTru || {};
    }
    return this.ipDangDung;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const uid = url.searchParams.get("uid");
    const ip = url.searchParams.get("ip");

    if (!uid || !ip) {
      return Response.json({ loi: "thieu_tham_so" }, { status: 400 });
    }

    const ipMap = await this.taiDuLieu();

    if (url.pathname === "/check") {
      const chuHienTai = ipMap[ip];
      if (chuHienTai && chuHienTai !== uid) {
        return Response.json({ duoc_phep: false });
      }
      ipMap[ip] = uid;
      await this.state.storage.put("ip_dang_dung", ipMap);
      return Response.json({ duoc_phep: true });
    }

    if (url.pathname === "/release") {
      if (ipMap[ip] === uid) {
        delete ipMap[ip];
        await this.state.storage.put("ip_dang_dung", ipMap);
      }
      return Response.json({ thanh_cong: true });
    }

    return new Response("not found", { status: 404 });
  }
}
