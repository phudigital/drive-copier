// ============================================================
//  DRIVE COPIER - Code.gs  (v3.5 — 2025-03-13)
//  Email + storage header · Drive info · folder sizes
// ============================================================

const APP_VERSION  = '3.5';
const APP_UPDATED  = '2025-03-13';
const HISTORY_KEY  = 'copy_history';
const PROGRESS_KEY = 'copy_progress';

// ---------- Entry point ----------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Drive Copier')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Trả về phiên bản, ngày cập nhật, email và dung lượng Drive */
function getAppInfo() {
  let email = '';
  try { email = Session.getActiveUser().getEmail(); } catch(e) {}
  let storage = null;
  try { storage = getDriveSpace(); } catch(e) {}
  return {
    version: APP_VERSION,
    updated: APP_UPDATED,
    email: email,
    storage: storage
  };
}

/** Trả về thông tin chi tiết Drive cho tab Quản lý */
function getDriveInfo() {
  let email = '', displayName = '';
  try {
    email = Session.getActiveUser().getEmail();
  } catch(e) {}
  try {
    const about = Drive.About.get({ fields: 'user' });
    displayName = about.user.displayName || '';
    if (!email) email = about.user.emailAddress || '';
  } catch(e) {}
  const storage = getDriveSpace();
  return {
    email: email,
    displayName: displayName,
    storage: storage
  };
}

// =====================================================================
//  FOLDER UTILITIES
// =====================================================================

function getFolders(parentId) {
  parentId = parentId || 'root';
  const folders = [];
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  let pageToken = null;
  do {
    const resp = Drive.Files.list({
      q: query,
      fields: 'nextPageToken, files(id, name)',
      pageToken: pageToken,
      pageSize: 200
    });
    (resp.files || []).forEach(f => folders.push({ id: f.id, name: f.name }));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return folders;
}

/**
 * Trả về danh sách thư mục kèm dung lượng (file trực tiếp, không đệ quy)
 * Dùng cho tab Quản lý. Có timeout protection 25s.
 */
function getFoldersManage(parentId) {
  parentId = parentId || 'root';
  const folders = getFolders(parentId);
  const startTime = Date.now();

  for (const folder of folders) {
    // Timeout protection: nếu quá 25s thì dừng tính size
    if (Date.now() - startTime > 25000) {
      folder.fileCount = -1;
      folder.size = -1;
      continue;
    }
    try {
      const childQuery = `'${folder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
      let totalSize = 0, fileCount = 0;
      let pt = null;
      do {
        const r = Drive.Files.list({
          q: childQuery,
          fields: 'nextPageToken, files(size)',
          pageSize: 1000,
          pageToken: pt
        });
        (r.files || []).forEach(f => { fileCount++; totalSize += parseInt(f.size || '0'); });
        pt = r.nextPageToken;
      } while (pt);
      folder.fileCount = fileCount;
      folder.size = totalSize;
    } catch(e) {
      folder.fileCount = -1;
      folder.size = -1;
    }
  }
  return folders;
}

/** Tạo thư mục mới, trả về { id, name } */
function createFolder(parentId, folderName) {
  folderName = (folderName || '').trim();
  if (!folderName) throw new Error('Tên thư mục không được để trống.');
  const parent = parentId === 'root' ? DriveApp.getRootFolder() : DriveApp.getFolderById(parentId);
  const newFolder = parent.createFolder(folderName);
  return { id: newFolder.getId(), name: newFolder.getName() };
}

/** Đổi tên thư mục */
function renameFolder(folderId, newName) {
  newName = (newName || '').trim();
  if (!newName) throw new Error('Tên thư mục không được để trống.');
  if (folderId === 'root') throw new Error('Không thể đổi tên thư mục root.');
  const folder = DriveApp.getFolderById(folderId);
  folder.setName(newName);
  return { id: folder.getId(), name: folder.getName() };
}

/** Xóa thư mục (chuyển vào thùng rác) */
function deleteFolder(folderId) {
  if (folderId === 'root') throw new Error('Không thể xóa thư mục root.');
  const folder = DriveApp.getFolderById(folderId);
  const name = folder.getName();
  folder.setTrashed(true);
  return { success: true, name: name };
}

/** Lấy thông tin chi tiết folder: số file + subfolder + tổng size */
function getFolderInfo(folderId) {
  if (folderId === 'root') {
    return { name: 'My Drive', files: -1, folders: -1, size: -1 };
  }
  const folder = DriveApp.getFolderById(folderId);
  const fileCount = countFiles(folder);
  const folderCount = countFolders(folder);
  const size = estimateFolderSize(folder);
  return {
    name: folder.getName(),
    files: fileCount,
    folders: folderCount,
    size: size
  };
}

/** Đếm tổng subfolder đệ quy */
function countFolders(folder) {
  let total = 0;
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    total++;
    total += countFolders(subs.next());
  }
  return total;
}

// =====================================================================
//  PARSE + DETECT
// =====================================================================

function parseId(input) {
  input = input.trim();
  let m = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'folder' };
  m = input.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'file' };
  m = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'unknown' };
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return { id: input, type: 'unknown' };
  return null;
}

function detectType(id) {
  try { DriveApp.getFolderById(id); return 'folder'; } catch(e) {}
  try { DriveApp.getFileById(id);   return 'file';   } catch(e) {}
  return null;
}

// =====================================================================
//  PROGRESS HELPERS  (UI polls getProgress() every 1.5s)
// =====================================================================

function setProgress(data) {
  // Thêm timestamp để frontend phân biệt update mới vs cũ
  data._ts = Date.now();
  PropertiesService.getUserProperties().setProperty(PROGRESS_KEY, JSON.stringify(data));
}

function getProgress() {
  try {
    return JSON.parse(
      PropertiesService.getUserProperties().getProperty(PROGRESS_KEY) || 'null'
    );
  } catch(e) { return null; }
}

function clearProgress() {
  PropertiesService.getUserProperties().deleteProperty(PROGRESS_KEY);
}

// =====================================================================
//  COUNT total files in folder tree (progress denominator)
// =====================================================================

function countFiles(folder) {
  let total = 0;
  const files = folder.getFiles();
  while (files.hasNext()) { files.next(); total++; }
  const subs = folder.getFolders();
  while (subs.hasNext()) total += countFiles(subs.next());
  return total;
}

// =====================================================================
//  DRIVE SPACE CHECK
// =====================================================================

/** Trả về { free, total, used } tính bằng bytes */
function getDriveSpace() {
  const about = Drive.About.get({ fields: 'storageQuota' });
  const quota = about.storageQuota;
  const total = parseInt(quota.limit || '0');
  const used  = parseInt(quota.usage || '0');
  const free  = total > 0 ? total - used : -1; // -1 = unlimited (Workspace unlimited)
  return { free: free, total: total, used: used };
}

/** Ước tính tổng size (bytes) của folder — Google Docs/Sheets/Slides = 0 (không tính quota) */
function estimateFolderSize(folder) {
  let size = 0;
  const files = folder.getFiles();
  while (files.hasNext()) size += files.next().getSize();
  const subs = folder.getFolders();
  while (subs.hasNext()) size += estimateFolderSize(subs.next());
  return size;
}

/** Kiểm tra dung lượng trước khi copy.
 *  Trả về { free, total, used, estimated, enough, unlimited }
 */
function checkSpace(sourceUrl) {
  const parsed = parseId(sourceUrl);
  if (!parsed) throw new Error('Không nhận ra định dạng link/ID.');

  let type = parsed.type;
  if (type === 'unknown') type = detectType(parsed.id);
  if (!type) throw new Error('Không thể truy cập file/folder. Kiểm tra quyền chia sẻ.');

  const space = getDriveSpace();
  let estimated = 0;
  if (type === 'folder') {
    estimated = estimateFolderSize(DriveApp.getFolderById(parsed.id));
  } else {
    estimated = DriveApp.getFileById(parsed.id).getSize();
  }

  const unlimited = space.free === -1;
  const enough    = unlimited || space.free >= estimated;

  return {
    free:      space.free,
    total:     space.total,
    used:      space.used,
    estimated: estimated,
    enough:    enough,
    unlimited: unlimited
  };
}


// =====================================================================
//  MAIN COPY  — overwriteMode: 'skip' | 'overwrite' | 'rename'
// =====================================================================

function copyItem(sourceUrl, destFolderId, overwriteMode) {
  overwriteMode = overwriteMode || 'rename';

  // Xóa progress cũ trước khi bắt đầu
  clearProgress();

  const parsed = parseId(sourceUrl);
  if (!parsed) throw new Error('Không nhận ra định dạng link/ID. Vui lòng kiểm tra lại.');

  let type = parsed.type;
  if (type === 'unknown') type = detectType(parsed.id);
  if (!type) throw new Error('Không thể truy cập file/folder. Kiểm tra quyền chia sẻ.');

  const destFolder = destFolderId === 'root'
    ? DriveApp.getRootFolder()
    : DriveApp.getFolderById(destFolderId);

  // Count total files for progress bar
  let total = 1;
  if (type === 'folder') {
    const srcForCount = DriveApp.getFolderById(parsed.id);
    total = countFiles(srcForCount) || 1;
  }

  setProgress({ done: 0, total: total, current: 'Đang chuẩn bị...', errors: [], status: 'running' });

  let result;
  try {
    if (type === 'folder') {
      const src = DriveApp.getFolderById(parsed.id);
      const counter = { done: 0, total: total };
      result = copyFolderRecursive(src, destFolder, overwriteMode, counter);
    } else {
      const src = DriveApp.getFileById(parsed.id);
      setProgress({ done: 0, total: 1, current: src.getName(), errors: [], status: 'running' });
      copySingleFile(src, destFolder, overwriteMode);
      result = { name: src.getName(), files: 1, folders: 0, errors: [] };
    }
  } catch(e) {
    setProgress({ done: 0, total: total, current: '', errors: [e.message], status: 'error' });
    throw e;
  }

  setProgress({
    done: result.files,
    total: total,
    current: 'Hoàn thành',
    errors: result.errors,
    status: 'done'
  });

  saveHistory({
    date: new Date().toLocaleString('vi-VN'),
    source: sourceUrl,
    dest: destFolder.getName(),
    type: type,
    name: result.name,
    files: result.files,
    folders: result.folders,
    errors: result.errors.length
  });

  return result;
}

// =====================================================================
//  COPY A SINGLE FILE  (skip / overwrite / rename)
// =====================================================================

function copySingleFile(srcFile, destFolder, overwriteMode) {
  const name = srcFile.getName();

  if (overwriteMode === 'skip') {
    const existing = destFolder.getFilesByName(name);
    if (existing.hasNext()) return 'skipped';
  }

  if (overwriteMode === 'overwrite') {
    const existing = destFolder.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);
  }

  // 'rename': makeCopy tự thêm (1), (2)... nếu trùng tên
  srcFile.makeCopy(name, destFolder);
  return 'copied';
}

// =====================================================================
//  RECURSIVE FOLDER COPY
// =====================================================================

function copyFolderRecursive(srcFolder, destParent, overwriteMode, counter) {
  const name = srcFolder.getName();
  let destSub;

  if (overwriteMode === 'overwrite') {
    const existing = destParent.getFoldersByName(name);
    destSub = existing.hasNext() ? existing.next() : destParent.createFolder(name);
  } else {
    destSub = destParent.createFolder(name);
  }

  let totalFiles   = 0;
  let totalFolders = 1;
  const errors     = [];

  // Copy files
  const files = srcFolder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    try {
      copySingleFile(f, destSub, overwriteMode);
      totalFiles++;
    } catch(e) {
      errors.push('❌ ' + f.getName() + ': ' + e.message);
    }
    counter.done++;
    setProgress({
      done: counter.done,
      total: counter.total,
      current: f.getName(),
      errors: errors,
      status: 'running'
    });
  }

  // Recurse sub-folders
  const subs = srcFolder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    try {
      const r = copyFolderRecursive(sub, destSub, overwriteMode, counter);
      totalFiles   += r.files;
      totalFolders += r.folders;
      errors.push(...r.errors);
    } catch(e) {
      errors.push('❌ 📁 ' + sub.getName() + ': ' + e.message);
    }
  }

  return { name: name, files: totalFiles, folders: totalFolders, errors: errors };
}

// =====================================================================
//  HISTORY
// =====================================================================

function saveHistory(entry) {
  const store = PropertiesService.getUserProperties();
  let history = [];
  try { history = JSON.parse(store.getProperty(HISTORY_KEY) || '[]'); } catch(e) {}
  history.unshift(entry);
  if (history.length > 50) history = history.slice(0, 50);
  store.setProperty(HISTORY_KEY, JSON.stringify(history));
}

function getHistory() {
  try {
    return JSON.parse(
      PropertiesService.getUserProperties().getProperty(HISTORY_KEY) || '[]'
    );
  } catch(e) { return []; }
}

function clearHistory() {
  PropertiesService.getUserProperties().deleteProperty(HISTORY_KEY);
}