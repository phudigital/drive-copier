# 📂 Drive Copier

![Drive Copier Thumbnail](https://raw.githubusercontent.com/phudigital/drive-copier/main/thumbnail.png)

> Copy file & folder từ Google Drive được chia sẻ về Drive cá nhân — nhanh, trực quan, không cần cài đặt.

---

## Tính năng

- **Copy file đơn lẻ** hoặc **toàn bộ folder** (bao gồm subfolder đệ quy)
- **Thanh tiến độ realtime** — hiển thị % và tên file đang copy
- **3 chế độ xử lý trùng tên**: đổi tên tự động / ghi đè / bỏ qua
- **Log lỗi từng file** — file lỗi được ghi lại, không dừng toàn bộ quá trình
- **Duyệt thư mục đích** với breadcrumb, tạo thư mục mới ngay tại chỗ
- **Lịch sử copy** — lưu 50 bản ghi gần nhất

---

## Yêu cầu

- Tài khoản Google (Gmail hoặc Workspace)
- Trình duyệt web bất kỳ
- File/folder nguồn phải được chia sẻ ở chế độ **"Anyone with the link"**

---

## Cài đặt

### Bước 1 — Tạo Apps Script project

1. Vào [script.google.com](https://script.google.com)
2. Click **New project**
3. Đặt tên project (ví dụ: `Drive Copier`)

### Bước 2 — Thêm code

**File `Code.gs`** (file mặc định khi tạo project):
- Xoá toàn bộ nội dung cũ
- Dán nội dung file `Code.gs` vào

**File `Index.html`** (tạo mới):
- Click biểu tượng **＋** bên cạnh "Files" → chọn **HTML**
- Đặt tên đúng là `Index` *(không có đuôi .html)*
- Dán nội dung file `Index.html` vào

### Bước 3 — Bật Drive API

1. Trong sidebar trái, click **Services** (biểu tượng ＋)
2. Tìm **Drive API** → chọn → click **Add**

### Bước 4 — Deploy

1. Click **Deploy** → **New deployment**
2. Chọn type: **Web app**
3. Cấu hình:
   - Execute as: **Me**
   - Who has access: **Only myself**
4. Click **Deploy** → **Authorize access** (đăng nhập Google)
5. Copy **Web app URL** — đây là link truy cập ứng dụng

---

## Cách dùng

### Copy file hoặc folder

1. Mở Web App URL trên trình duyệt
2. Dán link Google Drive vào ô **Nguồn**
   - Hỗ trợ: link folder, link file, link dạng `?id=...`, hoặc ID thuần
3. Chọn **chế độ khi trùng tên**:
   - 🟢 **Đổi tên** *(mặc định)*: an toàn, tự thêm `(1)`, `(2)`...
   - 🟡 **Ghi đè**: xoá file cũ, thay bằng file mới
   - ⚪ **Bỏ qua**: giữ file cũ, không copy file mới
4. Chọn **thư mục đích** trong Drive của bạn
   - Click vào thư mục để chọn
   - Double-click để đi vào bên trong
   - Click breadcrumb để quay lại
   - Nhấn **＋ Tạo thư mục** để tạo mới
5. Click **⬇ Bắt đầu Copy**

### Xem lịch sử

- Chuyển sang tab **🕒 Lịch sử** để xem các lần copy gần đây
- Hiển thị: tên, thư mục đích, thời gian, số file/folder, số lỗi

---

## Giới hạn

| Giới hạn | Chi tiết |
|----------|----------|
| Thời gian chạy tối đa | 6 phút / lần (giới hạn của Apps Script) |
| Số file khuyến nghị | < 500 file / lần copy |
| Lịch sử lưu | 50 bản ghi gần nhất |
| Người dùng | Chỉ chủ tài khoản (deploy mode "Execute as: Me") |

> ⚠ Với folder rất lớn (>500 file), nên chia nhỏ thành nhiều lần copy để tránh timeout.

---

## Cấu trúc file

```
drive-copier/
├── Code.gs       # Backend: logic copy, progress, history
├── Index.html    # Frontend: giao diện web
├── README.md     # Tài liệu này
└── AGENTS.md     # Tài liệu kỹ thuật cho developer / AI agent
```

---

## Cập nhật sau khi sửa code

Mỗi lần sửa `Code.gs` hoặc `Index.html`, cần deploy lại:

1. **Deploy** → **Manage deployments**
2. Click biểu tượng ✏️ chỉnh sửa
3. Chọn **Version: New version**
4. Click **Deploy**

---

## Công nghệ sử dụng

- [Google Apps Script](https://developers.google.com/apps-script) — runtime & hosting
- [Google Drive API v3](https://developers.google.com/drive/api/v3/reference) — thao tác với Drive
- HTML / CSS / JavaScript thuần — không dùng framework hay thư viện ngoài

---

## License

Dự án cá nhân — dùng tự do cho mục đích phi thương mại.