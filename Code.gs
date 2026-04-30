// ============================================================
//  DRIVE COPIER - Code.gs  (v3.8 — 2026-05-01)
//  Email + storage header · Drive info · folder sizes
// ============================================================

const APP_VERSION  = '3.8';
const APP_UPDATED  = '2026-05-01';
const HISTORY_KEY  = 'copy_history';
const PROGRESS_KEY = 'copy_progress';
const COPY_STATE_KEY = 'copy_state';
const COPY_BATCH_MS = 180000;
const COPY_ERROR_LIMIT = 30;
const COPY_RETRY_LIMIT = 3;
const COPY_RETRY_DELAY_MS = 1200;
const SPACE_CHECK_MS = 20000;
const SPACE_CHECK_FILE_LIMIT = 2000;
const SPACE_CHECK_FOLDER_LIMIT = 500;
const MANAGE_SCAN_MS = 25000;
const MANAGE_SCAN_FILE_LIMIT = 5000;
const MANAGE_SCAN_FOLDER_LIMIT = 1000;
const COPY_TRIGGER_HANDLER = 'continueCopyByTrigger';
const COPY_TRIGGER_DELAY_MS = 60000;

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
 * Trả về danh sách thư mục kèm dung lượng đệ quy.
 * Dùng cho tab Quản lý. Có timeout protection để tránh treo với cây quá lớn.
 */
function getFoldersManage(parentId) {
  parentId = parentId || 'root';
  const folders = getFolders(parentId);
  const deadlineAt = Date.now() + MANAGE_SCAN_MS;

  for (const folder of folders) {
    if (Date.now() > deadlineAt) {
      folder.fileCount = -1;
      folder.folderCount = -1;
      folder.size = -1;
      folder.partial = true;
      continue;
    }
    try {
      const summary = summarizeFolderTreeLimited(folder.id, deadlineAt);
      folder.fileCount = summary.fileCount;
      folder.folderCount = summary.folderCount;
      folder.size = summary.size;
      folder.partial = summary.partial;
    } catch(e) {
      folder.fileCount = -1;
      folder.folderCount = -1;
      folder.size = -1;
      folder.partial = true;
    }
  }
  return folders;
}

function summarizeFolderTreeLimited(rootFolderId, deadlineAt) {
  const pending = [rootFolderId];
  let size = 0;
  let fileCount = 0;
  let folderCount = 0;
  let partial = false;

  while (pending.length) {
    if (Date.now() > deadlineAt || fileCount >= MANAGE_SCAN_FILE_LIMIT || folderCount >= MANAGE_SCAN_FOLDER_LIMIT) {
      partial = true;
      break;
    }

    const folderId = pending.pop();
    const query = `'${folderId}' in parents and trashed = false`;
    let pageToken = null;

    do {
      if (Date.now() > deadlineAt || fileCount >= MANAGE_SCAN_FILE_LIMIT || folderCount >= MANAGE_SCAN_FOLDER_LIMIT) {
        partial = true;
        break;
      }

      const resp = Drive.Files.list({
        q: query,
        fields: 'nextPageToken, files(id, mimeType, size)',
        pageSize: 1000,
        pageToken: pageToken
      });

      (resp.files || []).forEach(function(item) {
        if (partial) return;
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          folderCount++;
          if (folderCount >= MANAGE_SCAN_FOLDER_LIMIT) {
            partial = true;
            return;
          }
          pending.push(item.id);
        } else {
          fileCount++;
          size += parseInt(item.size || '0');
          if (fileCount >= MANAGE_SCAN_FILE_LIMIT) {
            partial = true;
          }
        }
      });

      pageToken = resp.nextPageToken;
    } while (pageToken && !partial);
  }

  if (pending.length) partial = true;
  return {
    size: size,
    fileCount: fileCount,
    folderCount: folderCount,
    partial: partial
  };
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

function saveCopyState(state) {
  PropertiesService.getUserProperties().setProperty(COPY_STATE_KEY, JSON.stringify(state));
}

function getCopyState() {
  try {
    return JSON.parse(
      PropertiesService.getUserProperties().getProperty(COPY_STATE_KEY) || 'null'
    );
  } catch(e) { return null; }
}

function clearCopyState() {
  PropertiesService.getUserProperties().deleteProperty(COPY_STATE_KEY);
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

function estimateFolderSizeLimited(rootFolder) {
  const startTime = Date.now();
  const pending = [rootFolder.getId()];
  let size = 0;
  let scannedFiles = 0;
  let scannedFolders = 0;
  let partial = false;

  while (pending.length) {
    if (Date.now() - startTime > SPACE_CHECK_MS || scannedFiles >= SPACE_CHECK_FILE_LIMIT || scannedFolders >= SPACE_CHECK_FOLDER_LIMIT) {
      partial = true;
      break;
    }

    const folder = DriveApp.getFolderById(pending.pop());
    scannedFolders++;

    const files = folder.getFiles();
    while (files.hasNext()) {
      if (Date.now() - startTime > SPACE_CHECK_MS || scannedFiles >= SPACE_CHECK_FILE_LIMIT) {
        partial = true;
        break;
      }
      size += files.next().getSize();
      scannedFiles++;
    }
    if (partial) break;

    const subs = folder.getFolders();
    while (subs.hasNext()) {
      if (Date.now() - startTime > SPACE_CHECK_MS || scannedFolders + pending.length >= SPACE_CHECK_FOLDER_LIMIT) {
        partial = true;
        break;
      }
      pending.push(subs.next().getId());
    }
    if (partial) break;
  }

  if (pending.length) partial = true;
  return {
    size: size,
    partial: partial,
    scannedFiles: scannedFiles,
    scannedFolders: scannedFolders
  };
}

/** Kiểm tra dung lượng trước khi copy.
 *  Folder lớn chỉ quét có giới hạn để tránh Apps Script bị treo/quá tải.
 */
function checkSpace(sourceUrl) {
  const parsed = parseId(sourceUrl);
  if (!parsed) throw new Error('Không nhận ra định dạng link/ID.');

  let type = parsed.type;
  if (type === 'unknown') type = detectType(parsed.id);
  if (!type) throw new Error('Không thể truy cập file/folder. Kiểm tra quyền chia sẻ.');

  const space = getDriveSpace();
  let estimated = 0;
  let partial = false;
  let scannedFiles = 0;
  let scannedFolders = 0;

  if (type === 'folder') {
    const scan = estimateFolderSizeLimited(DriveApp.getFolderById(parsed.id));
    estimated = scan.size;
    partial = scan.partial;
    scannedFiles = scan.scannedFiles;
    scannedFolders = scan.scannedFolders;
  } else {
    estimated = DriveApp.getFileById(parsed.id).getSize();
    scannedFiles = 1;
  }

  const unlimited = space.free === -1;
  const enough    = unlimited || (!partial && space.free >= estimated);

  return {
    free:      space.free,
    total:     space.total,
    used:      space.used,
    estimated: estimated,
    enough:    enough,
    unlimited: unlimited,
    partial:   partial,
    scannedFiles: scannedFiles,
    scannedFolders: scannedFolders
  };
}


// =====================================================================
//  MAIN COPY  — overwriteMode: 'skip' | 'overwrite' | 'rename'
// =====================================================================

function copyItem(sourceUrl, destFolderId, overwriteMode) {
  overwriteMode = overwriteMode || 'rename';

  // Xóa progress/trạng thái cũ trước khi bắt đầu phiên copy mới.
  clearProgress();
  clearCopyState();
  clearCopyTriggers();

  const parsed = parseId(sourceUrl);
  if (!parsed) throw new Error('Không nhận ra định dạng link/ID. Vui lòng kiểm tra lại.');

  let type = parsed.type;
  if (type === 'unknown') type = detectType(parsed.id);
  if (!type) throw new Error('Không thể truy cập file/folder. Kiểm tra quyền chia sẻ.');

  const destFolder = destFolderId === 'root'
    ? DriveApp.getRootFolder()
    : DriveApp.getFolderById(destFolderId);

  let result;
  try {
    if (type === 'folder') {
      const src = DriveApp.getFolderById(parsed.id);
      const rootDest = prepareDestinationFolder(src.getName(), destFolder, overwriteMode);
      const state = {
        status: 'running',
        source: sourceUrl,
        destName: destFolder.getName(),
        type: type,
        name: src.getName(),
        overwriteMode: overwriteMode,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        nextTriggerAt: null,
        lastCurrent: 'Đang chuẩn bị copy theo lô...',
        files: 0,
        bytesCopied: 0,
        folders: 1,
        errors: [],
        stack: [{
          srcId: src.getId(),
          destId: rootDest.getId(),
          phase: 'files',
          filesToken: null,
          subsToken: null
        }]
      };
      saveCopyState(state);
      setProgress({
        done: 0,
        total: 0,
        current: 'Đang chuẩn bị copy theo lô...',
        bytesCopied: 0,
        errors: [],
        status: 'running'
      });
      result = processCopyState(state);
    } else {
      const src = DriveApp.getFileById(parsed.id);
      setProgress({ done: 0, total: 1, current: src.getName(), errors: [], status: 'running' });
      const fileSize = src.getSize();
      const copyStatus = copySingleFile(src, destFolder, overwriteMode);
      const bytesCopied = copyStatus === 'skipped' ? 0 : fileSize;
      const result = { name: src.getName(), files: 1, folders: 0, bytesCopied: bytesCopied, errors: [], status: 'done' };
      finishCopy(result, sourceUrl, destFolder.getName(), type);
      return result;
    }
  } catch(e) {
    const failedState = getCopyState();
    if (failedState) {
      failedState.status = 'error';
      failedState.updatedAt = Date.now();
      failedState.lastCurrent = e.message;
      saveCopyState(failedState);
    }
    clearCopyTriggers();
    setProgress({ done: 0, total: 0, current: '', errors: [e.message], status: 'error' });
    throw e;
  }

  if (result.status === 'done') {
    finishCopy(result, sourceUrl, destFolder.getName(), type);
  }

  return result;
}

function continueCopy() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    const state = getCopyState();
    return state ? stateToRunningResult(state) : {
      name: '',
      files: 0,
      folders: 0,
      bytesCopied: 0,
      errors: [],
      status: 'running'
    };
  }

  const state = getCopyState();
  try {
    if (!state || state.status !== 'running') {
      throw new Error('Không có phiên copy đang chạy để tiếp tục.');
    }
    const result = processCopyState(state);
    if (result.status === 'done') {
      finishCopy(result, state.source, state.destName, state.type);
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function continueCopyByTrigger() {
  try {
    const state = getCopyState();
    if (!state || state.status !== 'running') {
      clearCopyTriggers();
      return;
    }
    continueCopy();
  } catch(e) {
    const state = getCopyState();
    if (state) {
      state.status = 'error';
      state.updatedAt = Date.now();
      state.lastCurrent = e.message;
      saveCopyState(state);
    }
    clearCopyTriggers();
    setProgress({
      done: 0,
      total: 0,
      current: '',
      errors: [e.message],
      status: 'error'
    });
  }
}

function getCopyStatus() {
  const progress = getProgress();
  const state = getCopyState();
  const copyTriggers = getProjectTriggerDetails().filter(function(trigger) {
    return trigger.handler === COPY_TRIGGER_HANDLER;
  });
  const triggerCount = copyTriggers.length;
  const progressStatus = progress && progress.status ? progress.status : '';
  const stateStatus = state && state.status ? state.status : '';
  let status = progressStatus || stateStatus || (triggerCount ? 'scheduled' : 'idle');

  if (stateStatus === 'running' && !triggerCount && progressStatus === 'running') {
    status = 'running';
  } else if (stateStatus === 'running' && triggerCount) {
    status = 'running';
  } else if (stateStatus === 'error') {
    status = 'error';
  }

  return {
    status: status,
    running: status === 'running' || status === 'scheduled',
    hasState: !!state,
    hasTrigger: triggerCount > 0,
    triggerCount: triggerCount,
    triggerHandler: COPY_TRIGGER_HANDLER,
    triggerIds: copyTriggers.map(function(trigger) { return trigger.id; }),
    source: state ? state.source : '',
    destName: state ? state.destName : '',
    name: (progress && progress.name) || (state && state.name) || '',
    current: (progress && progress.current) || (state && state.lastCurrent) || '',
    files: (progress && typeof progress.done === 'number') ? progress.done : (state ? state.files : 0),
    folders: (progress && typeof progress.folders === 'number') ? progress.folders : (state ? state.folders : 0),
    bytesCopied: (progress && typeof progress.bytesCopied === 'number') ? progress.bytesCopied : (state ? state.bytesCopied || 0 : 0),
    errors: (progress && progress.errors) || (state && state.errors) || [],
    startedAt: state ? state.startedAt || null : null,
    updatedAt: (progress && progress._ts) || (state && state.updatedAt) || null,
    nextTriggerAt: state ? state.nextTriggerAt || null : null
  };
}

function getTriggerDashboard() {
  const triggers = getProjectTriggerDetails();
  const copyStatus = getCopyStatus();
  return {
    checkedAt: Date.now(),
    copyStatus: copyStatus,
    triggers: triggers,
    copyTriggers: triggers.filter(function(trigger) {
      return trigger.handler === COPY_TRIGGER_HANDLER;
    }),
    limits: {
      scriptRuntimeMin: 6,
      simultaneousExecutionsPerUser: 30,
      simultaneousExecutionsPerScript: 1000,
      triggersPerUserPerScript: 20,
      triggerRuntimeConsumerMinPerDay: 90,
      triggerRuntimeWorkspaceHrPerDay: 6
    },
    appMode: {
      appsScriptSupportsParallelExecutions: true,
      parallelCopyEnabled: false,
      stateKey: COPY_STATE_KEY,
      progressKey: PROGRESS_KEY,
      reason: 'Phiên copy hiện tại dùng một copy_state duy nhất để tránh hai lượt copy ghi đè trạng thái của nhau.'
    }
  };
}

function cancelCopy() {
  const state = getCopyState();
  const progress = getProgress();
  clearCopyTriggers();
  clearCopyState();

  setProgress({
    done: (progress && typeof progress.done === 'number') ? progress.done : (state ? state.files : 0),
    total: 0,
    current: 'Đã hủy phiên copy nền.',
    name: (progress && progress.name) || (state && state.name) || '',
    folders: (progress && typeof progress.folders === 'number') ? progress.folders : (state ? state.folders : 0),
    bytesCopied: (progress && typeof progress.bytesCopied === 'number') ? progress.bytesCopied : (state ? state.bytesCopied || 0 : 0),
    errors: (progress && progress.errors) || (state && state.errors) || [],
    status: 'cancelled'
  });

  return getCopyStatus();
}

function resumeCopyNow() {
  const state = getCopyState();
  if (!state || state.status !== 'running') {
    return getCopyStatus();
  }
  continueCopy();
  return getCopyStatus();
}

function finishCopy(result, sourceUrl, destName, type) {
  setProgress({
    done: result.files,
    total: result.files || 1,
    current: 'Hoàn thành',
    name: result.name,
    folders: result.folders || 0,
    bytesCopied: result.bytesCopied || 0,
    errors: result.errors,
    status: 'done'
  });

  saveHistory({
    date: new Date().toLocaleString('vi-VN'),
    source: sourceUrl,
    dest: destName,
    type: type,
    name: result.name,
    files: result.files,
    folders: result.folders,
    bytesCopied: result.bytesCopied || 0,
    errors: result.errors.length
  });
  clearCopyTriggers();
  clearCopyState();
}

function stateToRunningResult(state) {
  return {
    name: state.name,
    files: state.files,
    folders: state.folders,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors || [],
    status: 'running'
  };
}

function stateToCancelledResult(state) {
  state.status = 'cancelled';
  return {
    name: state.name,
    files: state.files,
    folders: state.folders,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors || [],
    status: 'cancelled'
  };
}

function isCopyCancelled(state) {
  const liveState = getCopyState();
  return !liveState || liveState.status !== 'running' || liveState.startedAt !== state.startedAt;
}

function scheduleCopyTrigger() {
  clearCopyTriggers();
  const nextTriggerAt = Date.now() + COPY_TRIGGER_DELAY_MS;
  ScriptApp.newTrigger(COPY_TRIGGER_HANDLER)
    .timeBased()
    .after(COPY_TRIGGER_DELAY_MS)
    .create();
  return nextTriggerAt;
}

function clearCopyTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === COPY_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function getCopyTriggerCount() {
  let count = 0;
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === COPY_TRIGGER_HANDLER) {
      count++;
    }
  });
  return count;
}

function getProjectTriggerDetails() {
  const triggers = ScriptApp.getProjectTriggers();
  return triggers.map(function(trigger) {
    return {
      id: safeTriggerValue(function() { return trigger.getUniqueId(); }),
      handler: safeTriggerValue(function() { return trigger.getHandlerFunction(); }),
      eventType: safeTriggerValue(function() { return String(trigger.getEventType()); }),
      source: safeTriggerValue(function() { return String(trigger.getTriggerSource()); }),
      sourceId: safeTriggerValue(function() { return trigger.getTriggerSourceId(); }),
      isCopyTrigger: safeTriggerValue(function() {
        return trigger.getHandlerFunction() === COPY_TRIGGER_HANDLER;
      }) === true
    };
  });
}

function safeTriggerValue(readValue) {
  try {
    const value = readValue();
    return value === null || value === undefined ? '' : value;
  } catch(e) {
    return '';
  }
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
  withDriveRetry(function() {
    return srcFile.makeCopy(name, destFolder);
  });
  return 'copied';
}

function prepareDestinationFolder(name, destParent, overwriteMode) {
  if (overwriteMode === 'overwrite') {
    const existing = destParent.getFoldersByName(name);
    return existing.hasNext() ? existing.next() : withDriveRetry(function() {
      return destParent.createFolder(name);
    });
  }
  return withDriveRetry(function() {
    return destParent.createFolder(name);
  });
}

function withDriveRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < COPY_RETRY_LIMIT; attempt++) {
    try {
      return operation();
    } catch(e) {
      lastError = e;
      if (!isTransientDriveError(e) || attempt === COPY_RETRY_LIMIT - 1) break;
      Utilities.sleep(COPY_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function isTransientDriveError(error) {
  const message = String(error && error.message || error || '');
  return /Dịch vụ bị lỗi|Service error|Service invoked too many times|Rate Limit|User rate limit|Backend Error/i.test(message);
}

function rememberCopyError(state, message) {
  state.errors.push(message);
  if (state.errors.length > COPY_ERROR_LIMIT) {
    state.errors = state.errors.slice(state.errors.length - COPY_ERROR_LIMIT);
  }
}

function shouldPauseBatch(startTime) {
  return Date.now() - startTime > COPY_BATCH_MS;
}

function saveRunningBatch(state, current) {
  state.updatedAt = Date.now();
  state.lastCurrent = current || 'Tạm dừng lô, đang chuẩn bị chạy tiếp...';
  state.nextTriggerAt = scheduleCopyTrigger();
  saveCopyState(state);
  setProgress({
    done: state.files,
    total: 0,
    current: state.lastCurrent,
    name: state.name,
    folders: state.folders || 0,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors,
    status: 'running',
    nextTriggerAt: state.nextTriggerAt
  });
  return stateToRunningResult(state);
}

function processCopyState(state) {
  const startTime = Date.now();

  while (state.stack.length) {
    if (isCopyCancelled(state)) return stateToCancelledResult(state);

    const task = state.stack[state.stack.length - 1];
    const srcFolder = DriveApp.getFolderById(task.srcId);
    const destFolder = DriveApp.getFolderById(task.destId);

    if (task.phase === 'files') {
      const files = task.filesToken
        ? DriveApp.continueFileIterator(task.filesToken)
        : srcFolder.getFiles();

      while (files.hasNext()) {
        if (state.files % 5 === 0 && isCopyCancelled(state)) return stateToCancelledResult(state);

        if (shouldPauseBatch(startTime)) {
          task.filesToken = files.getContinuationToken();
          return saveRunningBatch(state, 'Đã copy ' + state.files + ' file. Đang chạy tiếp...');
        }

        const f = files.next();
        const fileSize = f.getSize();
        try {
          const copyStatus = copySingleFile(f, destFolder, state.overwriteMode);
          state.files++;
          if (copyStatus !== 'skipped') state.bytesCopied += fileSize;
        } catch(e) {
          rememberCopyError(state, '❌ ' + f.getName() + ': ' + e.message);
        }

        if (state.files % 5 === 0) {
          setProgress({
            done: state.files,
            total: 0,
            current: f.getName(),
            bytesCopied: state.bytesCopied || 0,
            errors: state.errors,
            status: 'running'
          });
        }
      }

      task.phase = 'folders';
      task.filesToken = null;
    }

    if (task.phase === 'folders') {
      const subs = task.subsToken
        ? DriveApp.continueFolderIterator(task.subsToken)
        : srcFolder.getFolders();

      while (subs.hasNext()) {
        if (isCopyCancelled(state)) return stateToCancelledResult(state);

        if (shouldPauseBatch(startTime)) {
          task.subsToken = subs.getContinuationToken();
          return saveRunningBatch(state, 'Đã copy ' + state.files + ' file. Đang chạy tiếp...');
        }

        const sub = subs.next();
        try {
          const childDest = prepareDestinationFolder(sub.getName(), destFolder, state.overwriteMode);
          state.folders++;
          task.subsToken = subs.getContinuationToken();
          state.stack.push({
            srcId: sub.getId(),
            destId: childDest.getId(),
            phase: 'files',
            filesToken: null,
            subsToken: null
          });
          setProgress({
            done: state.files,
            total: 0,
            current: '📁 ' + sub.getName(),
            bytesCopied: state.bytesCopied || 0,
            errors: state.errors,
            status: 'running'
          });
          break;
        } catch(e) {
          rememberCopyError(state, '❌ 📁 ' + sub.getName() + ': ' + e.message);
        }
      }

      if (state.stack[state.stack.length - 1] !== task) continue;
      task.subsToken = null;
      state.stack.pop();
    }
  }

  state.status = 'done';
  clearCopyState();
  return {
    name: state.name,
    files: state.files,
    folders: state.folders,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors,
    status: 'done'
  };
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
