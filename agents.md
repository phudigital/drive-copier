# AGENTS.md — Drive Copier

Tài liệu này mô tả kiến trúc, vai trò các thành phần, và hướng dẫn cho AI agent khi làm việc với dự án này.

---

## Tổng quan dự án

**Drive Copier** là Google Apps Script Web App cho phép người dùng copy file/folder từ Google Drive được chia sẻ về Drive cá nhân, với giao diện web đơn giản, không cần cài đặt hay server riêng.

---

## Cấu trúc dự án

```
drive-copier/
├── Code.gs       # Backend — toàn bộ logic server-side (Apps Script)
└── Index.html    # Frontend — giao diện web (HTML + CSS + JS thuần)
```

Không có file thứ ba. Mọi style và script đều nằm trong `Index.html`.

---

## Vai trò từng file

### `Code.gs` — Backend Agent

| Hàm | Vai trò |
|-----|---------|
| `doGet()` | Entry point, trả về HTML web app |
| `getFolders(parentId)` | Liệt kê thư mục con trong Drive |
| `createFolder(parentId, name)` | Tạo thư mục mới, trả về `{ id, name }` |
| `parseId(input)` | Parse URL hoặc raw ID → `{ id, type }` |
| `detectType(id)` | Phân biệt file hay folder qua DriveApp |
| `copyItem(url, destId, mode)` | Hàm chính — điều phối toàn bộ quá trình copy |
| `copySingleFile(file, dest, mode)` | Copy 1 file với xử lý trùng tên |
| `copyFolderRecursive(folder, dest, mode, counter)` | Copy đệ quy folder + subfolder |
| `countFiles(folder)` | Đếm tổng file để tính % tiến độ |
| `setProgress(data)` / `getProgress()` | Lưu/đọc tiến độ qua UserProperties |
| `saveHistory(entry)` / `getHistory()` | Lịch sử copy (tối đa 50, dùng UserProperties) |
| `clearHistory()` | Xoá lịch sử |

### `Index.html` — Frontend Agent

| Khu vực | Vai trò |
|---------|---------|
| Tab **Copy** | Form nhập link, chọn chế độ, duyệt thư mục đích, nút copy |
| Tab **Lịch sử** | Hiển thị lịch sử copy, nút xoá |
| `startCopy()` | Gọi `copyItem` + bắt đầu polling |
| `startPolling()` | Gọi `getProgress()` mỗi 1500ms, cập nhật UI |
| `showProgress()` | Render progress bar, % và error log |
| `loadFolders()` / `renderFolders()` | Load và hiển thị danh sách thư mục |
| `navInto()` / `navTo()` | Điều hướng breadcrumb |
| `confirmNewFolder()` | Gọi `createFolder` rồi navigate vào folder mới |

---

## Luồng dữ liệu

```
[User nhập link]
      │
      ▼
parseId() → detectType()
      │
      ▼
countFiles()  ──────────────────→  setProgress({ total })
      │
      ▼
copyFolderRecursive() / copySingleFile()
      │  (mỗi file xong)
      ▼
setProgress({ done++, current })  ←── polling từ frontend mỗi 1.5s
      │
      ▼
saveHistory()  →  return result  →  UI hiển thị kết quả
```

---

## Quy tắc quan trọng cho agent

### Drive API
- Luôn dùng **Drive API v3**: `files(id, name)`, `pageSize`, `nextPageToken`
- **Không dùng** `items`, `title`, `maxResults` (đây là v2, đã deprecated)
- Service cần bật: **Drive API** trong Apps Script → Services

### Overwrite modes
- `rename` *(default)*: dùng `makeCopy(name, dest)` — tự thêm `(1)`, `(2)`
- `overwrite`: `setTrashed(true)` file cũ trước, rồi `makeCopy`
- `skip`: kiểm tra `getFilesByName(name).hasNext()` trước khi copy

### Progress polling
- Backend lưu tiến độ vào `UserProperties` key `copy_progress`
- Frontend dùng `setInterval` 1500ms gọi `getProgress()`
- Trạng thái: `running` → `done` hoặc `error`
- Polling tự dừng khi nhận `status === 'done'` hoặc `'error'`

### Giới hạn Apps Script
- Timeout tối đa: **6 phút** mỗi lần chạy
- Không copy được folder quá lớn (>500 file) trong 1 lần
- Chỉ hoạt động với tài khoản **Google** (cá nhân hoặc Workspace)
- Deploy mode **"Execute as: Me"** → chỉ copy vào Drive của chủ tài khoản

### Bảo mật
- Web App URL là bí mật — ai có link đều truy cập được
- Không lưu credentials, password hay token trong code
- Dữ liệu lịch sử lưu trong `UserProperties` — chỉ owner mới đọc được

---

## Hướng dẫn khi chỉnh sửa

| Muốn thay đổi | Sửa ở đâu |
|---------------|-----------|
| Thêm tính năng backend | `Code.gs` |
| Thay đổi giao diện | `Index.html` — phần `<style>` |
| Thêm tương tác UI | `Index.html` — phần `<script>` |
| Thay đổi giới hạn lịch sử | `Code.gs` — dòng `if (history.length > 50)` |
| Thay đổi tần suất polling | `Index.html` — giá trị `1500` trong `setInterval` |
| Thêm overwrite mode mới | Cả `Code.gs` (copySingleFile) và `Index.html` (mode-group) |

---

## Deploy checklist

- [ ] Bật **Drive API** trong Apps Script → Services
- [ ] Deploy → New deployment → Type: **Web app**
- [ ] Execute as: **Me**
- [ ] Who has access: **Only myself** (hoặc Anyone nếu muốn chia sẻ)
- [ ] Copy URL và lưu lại
- [ ] Khi sửa code: **Deploy → Manage deployments → chọn version mới**