// ============================================================
//  DRIVE COPIER - Code.gs  (v2 — progress + overwrite + mkdir)
// ============================================================

const HISTORY_KEY  = 'copy_history';
const PROGRESS_KEY = 'copy_progress';

// ---------- Entry point ----------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Drive Copier')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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

/** Tạo thư mục mới, trả về { id, name } */
function createFolder(parentId, folderName) {
  folderName = (folderName || '').trim();
  if (!folderName) throw new Error('Tên thư mục không được để trống.');
  const parent = parentId === 'root' ? DriveApp.getRootFolder() : DriveApp.getFolderById(parentId);
  const newFolder = parent.createFolder(folderName);
  return { id: newFolder.getId(), name: newFolder.getName() };
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
//  MAIN COPY  — overwriteMode: 'skip' | 'overwrite' | 'rename'
// =====================================================================

function copyItem(sourceUrl, destFolderId, overwriteMode) {
  overwriteMode = overwriteMode || 'rename';

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