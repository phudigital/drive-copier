// ============================================================
//  DRIVE COPIER - Code.gs  (v4.0 — 2026-05-01)
//  Email + storage header · Drive info · folder sizes
// ============================================================

const APP_VERSION  = '4.0';
const APP_UPDATED  = '2026-05-01';
const HISTORY_KEY  = 'copy_history';
const PROGRESS_KEY = 'copy_progress';
const COPY_STATE_KEY = 'copy_state';
const COPY_SESSION_REGISTRY_KEY = 'copy_sessions';
const COPY_SESSION_STATE_PREFIX = 'copy_state_';
const COPY_SESSION_PROGRESS_PREFIX = 'copy_progress_';
const COPY_MAX_PARALLEL_SESSIONS = 3;
const COPY_SESSION_HISTORY_LIMIT = 20;
const COPY_START_WAIT = 'wait';
const COPY_START_PARALLEL = 'parallel';
const COPY_BATCH_MS = 180000;
const COPY_ERROR_LIMIT = 30;
const COPY_RETRY_LIMIT = 3;
const COPY_RETRY_DELAY_MS = 1200;
const SPACE_CHECK_MS = 120000;
const SPACE_CHECK_MAX_DEPTH = 5;
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
//  SESSION + PROGRESS HELPERS
// =====================================================================

function copyStateKey(sessionId) {
  return COPY_SESSION_STATE_PREFIX + sessionId;
}

function copyProgressKey(sessionId) {
  return COPY_SESSION_PROGRESS_PREFIX + sessionId;
}

function setProgress(data, sessionId) {
  sessionId = normalizeCopySessionId(sessionId || data.sessionId, false);
  data._ts = Date.now();
  if (sessionId) {
    data.sessionId = sessionId;
    registerCopySession(sessionId);
    PropertiesService.getUserProperties().setProperty(copyProgressKey(sessionId), JSON.stringify(data));
    return;
  }
  PropertiesService.getUserProperties().setProperty(PROGRESS_KEY, JSON.stringify(data));
}

function getProgress(sessionId) {
  const store = PropertiesService.getUserProperties();
  sessionId = normalizeCopySessionId(sessionId, false);
  try {
    if (sessionId) {
      return JSON.parse(store.getProperty(copyProgressKey(sessionId)) || 'null');
    }
    const selected = chooseCopySessionForStatus(getCopySessions());
    if (selected && selected.sessionId) {
      return JSON.parse(store.getProperty(copyProgressKey(selected.sessionId)) || 'null');
    }
    return JSON.parse(store.getProperty(PROGRESS_KEY) || 'null');
  } catch(e) {
    return null;
  }
}

function clearProgress(sessionId) {
  const store = PropertiesService.getUserProperties();
  sessionId = normalizeCopySessionId(sessionId, false);
  if (sessionId) {
    store.deleteProperty(copyProgressKey(sessionId));
    return;
  }
  store.deleteProperty(PROGRESS_KEY);
}

function saveCopyState(state) {
  if (!state.sessionId) state.sessionId = generateCopySessionId();
  state.updatedAt = state.updatedAt || Date.now();
  registerCopySession(state.sessionId);
  PropertiesService.getUserProperties().setProperty(copyStateKey(state.sessionId), JSON.stringify(state));
}

function getCopyState(sessionId) {
  const store = PropertiesService.getUserProperties();
  sessionId = normalizeCopySessionId(sessionId, false);
  try {
    if (sessionId) {
      return JSON.parse(store.getProperty(copyStateKey(sessionId)) || 'null');
    }
    return JSON.parse(store.getProperty(COPY_STATE_KEY) || 'null');
  } catch(e) {
    return null;
  }
}

function clearCopyState(sessionId) {
  const store = PropertiesService.getUserProperties();
  sessionId = normalizeCopySessionId(sessionId, false);
  if (sessionId) {
    store.deleteProperty(copyStateKey(sessionId));
    return;
  }
  store.deleteProperty(COPY_STATE_KEY);
}

function getCopySessionIds() {
  try {
    const ids = JSON.parse(PropertiesService.getUserProperties().getProperty(COPY_SESSION_REGISTRY_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  } catch(e) {
    return [];
  }
}

function saveCopySessionIds(ids) {
  const unique = [];
  ids.forEach(function(id) {
    if (id && unique.indexOf(id) === -1) unique.push(id);
  });
  PropertiesService.getUserProperties().setProperty(COPY_SESSION_REGISTRY_KEY, JSON.stringify(unique));
}

function registerCopySession(sessionId) {
  if (!sessionId) return;
  let ids = getCopySessionIds();
  if (ids.indexOf(sessionId) === -1) ids.push(sessionId);
  ids = pruneCopySessionIds(ids);
  saveCopySessionIds(ids);
}

function pruneCopySessionIds(ids) {
  if (ids.length <= COPY_SESSION_HISTORY_LIMIT) return ids;
  const keep = ids.slice();
  const store = PropertiesService.getUserProperties();
  while (keep.length > COPY_SESSION_HISTORY_LIMIT) {
    const candidate = keep[0];
    const state = getCopyState(candidate);
    const progress = getProgress(candidate);
    const status = (state && state.status) || (progress && progress.status) || '';
    if (status === 'running' || status === 'queued') {
      keep.push(keep.shift());
      if (keep.every(function(id) {
        const s = getCopyState(id);
        const p = getProgress(id);
        const st = (s && s.status) || (p && p.status) || '';
        return st === 'running' || st === 'queued';
      })) break;
      continue;
    }
    store.deleteProperty(copyStateKey(candidate));
    store.deleteProperty(copyProgressKey(candidate));
    keep.shift();
  }
  return keep.slice(Math.max(0, keep.length - COPY_SESSION_HISTORY_LIMIT));
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
  return estimateFolderSizeByDepth(rootFolder.getId(), SPACE_CHECK_MAX_DEPTH);
}

function estimateFolderSizeByDepth(rootFolderId, maxDepth) {
  const deadlineAt = Date.now() + SPACE_CHECK_MS;
  const pending = [{ id: rootFolderId, depth: 0 }];
  let cursor = 0;
  let size = 0;
  let scannedFiles = 0;
  let scannedFolders = 0;
  let maxDepthReached = 0;
  let partial = false;
  let depthLimitHit = false;
  let timedOut = false;

  while (cursor < pending.length) {
    if (Date.now() > deadlineAt) {
      partial = true;
      timedOut = true;
      break;
    }

    const task = pending[cursor++];
    scannedFolders++;
    maxDepthReached = Math.max(maxDepthReached, task.depth);
    const query = `'${task.id}' in parents and trashed = false`;
    let pageToken = null;

    do {
      if (Date.now() > deadlineAt) {
        partial = true;
        timedOut = true;
        break;
      }

      const resp = Drive.Files.list({
        q: query,
        fields: 'nextPageToken, files(id, mimeType, size)',
        pageSize: 1000,
        pageToken: pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      (resp.files || []).forEach(function(item) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          if (task.depth >= maxDepth) {
            partial = true;
            depthLimitHit = true;
            return;
          }
          pending.push({ id: item.id, depth: task.depth + 1 });
          return;
        }
        scannedFiles++;
        size += parseInt(item.size || '0');
      });

      pageToken = resp.nextPageToken;
    } while (pageToken && !timedOut);
  }

  if (cursor < pending.length) partial = true;
  return {
    size: size,
    partial: partial,
    scannedFiles: scannedFiles,
    scannedFolders: scannedFolders,
    maxDepth: maxDepth,
    maxDepthReached: maxDepthReached,
    depthLimitHit: depthLimitHit,
    timedOut: timedOut
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
  let maxDepth = 0;
  let maxDepthReached = 0;
  let depthLimitHit = false;
  let timedOut = false;

  if (type === 'folder') {
    const scan = estimateFolderSizeLimited(DriveApp.getFolderById(parsed.id));
    estimated = scan.size;
    partial = scan.partial;
    scannedFiles = scan.scannedFiles;
    scannedFolders = scan.scannedFolders;
    maxDepth = scan.maxDepth;
    maxDepthReached = scan.maxDepthReached;
    depthLimitHit = scan.depthLimitHit;
    timedOut = scan.timedOut;
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
    scannedFolders: scannedFolders,
    maxDepth: maxDepth,
    maxDepthReached: maxDepthReached,
    depthLimitHit: depthLimitHit,
    timedOut: timedOut
  };
}


// =====================================================================
//  MAIN COPY  — overwriteMode: 'skip' | 'overwrite' | 'rename'
// =====================================================================

function copyItem(sourceUrl, destFolderId, overwriteMode, startMode, requestedSessionId) {
  overwriteMode = overwriteMode || 'rename';
  startMode = normalizeCopyStartMode(startMode);

  const parsed = parseId(sourceUrl);
  if (!parsed) throw new Error('Không nhận ra định dạng link/ID. Vui lòng kiểm tra lại.');

  let type = parsed.type;
  if (type === 'unknown') type = detectType(parsed.id);
  if (!type) throw new Error('Không thể truy cập file/folder. Kiểm tra quyền chia sẻ.');

  const destFolder = destFolderId === 'root'
    ? DriveApp.getRootFolder()
    : DriveApp.getFolderById(destFolderId);
  const sourceName = type === 'folder'
    ? DriveApp.getFolderById(parsed.id).getName()
    : DriveApp.getFileById(parsed.id).getName();
  const sessionId = normalizeCopySessionId(requestedSessionId, true);
  const state = createCopySessionState({
    sessionId: sessionId,
    sourceUrl: sourceUrl,
    sourceId: parsed.id,
    destFolderId: destFolderId || 'root',
    destName: destFolder.getName(),
    type: type,
    name: sourceName,
    overwriteMode: overwriteMode,
    startMode: startMode
  });

  const lock = LockService.getUserLock();
  lock.waitLock(5000);
  try {
    const activeSessions = getActiveCopySessions();
    const shouldQueue = startMode === COPY_START_WAIT && activeSessions.length > 0;
    if (shouldQueue || activeSessions.length >= COPY_MAX_PARALLEL_SESSIONS) {
      state.status = 'queued';
      state.queueReason = activeSessions.length >= COPY_MAX_PARALLEL_SESSIONS
        ? 'Đã đạt tối đa ' + COPY_MAX_PARALLEL_SESSIONS + ' phiên chạy song song.'
        : 'Bạn chọn chờ phiên đang chạy hoàn tất trước.';
      state.lastCurrent = 'Đang chờ slot chạy nền...';
      saveCopyState(state);
      setProgress({
        done: 0,
        total: 0,
        current: state.lastCurrent,
        name: state.name,
        source: state.source,
        destName: state.destName,
        type: state.type,
        folders: 0,
        bytesCopied: 0,
        errors: [],
        status: 'queued',
        queueReason: state.queueReason
      }, sessionId);
      return stateToQueuedResult(state);
    }
    state.status = 'starting';
    state.lastCurrent = 'Đang giữ slot chạy song song...';
    saveCopyState(state);
  } finally {
    lock.releaseLock();
  }

  try {
    activateCopySession(state, false);
    const result = continueCopy(sessionId);
    return result;
  } catch(e) {
    const progress = getProgress(sessionId);
    if (!progress || progress.status !== 'error') {
      markCopySessionError(sessionId, e);
    }
    throw e;
  }
}

function continueCopy(sessionId) {
  sessionId = normalizeCopySessionId(sessionId, false) || findNextRunnableSessionId();
  if (!sessionId) throw new Error('Không có phiên copy đang chạy để tiếp tục.');

  let lease = acquireCopySessionLease(sessionId);
  if (!lease || lease.busy) {
    const busyState = getCopyState(sessionId);
    return busyState ? stateToRunningResult(busyState) : getCopyStatus(sessionId);
  }

  let done = false;
  try {
    const state = lease.state;
    clearCopyTriggers(sessionId);
    state.triggerId = '';
    state.nextTriggerAt = null;
    saveCopyState(state);

    const result = processCopyState(state);
    if (result.status === 'done') {
      done = true;
      finishCopy(result, state);
    }
    return result;
  } catch(e) {
    markCopySessionError(sessionId, e);
    throw e;
  } finally {
    if (!done) releaseCopySessionLease(sessionId, lease.leaseId);
  }
}

function continueCopyByTrigger(e) {
  const triggerUid = e && e.triggerUid ? String(e.triggerUid) : '';
  const sessionId = triggerUid ? findSessionIdByTriggerUid(triggerUid) : findNextRunnableSessionId();
  try {
    if (!sessionId) {
      if (triggerUid) clearCopyTriggersById(triggerUid);
      promoteQueuedSessions();
      return;
    }
    const state = getCopyState(sessionId);
    if (!state || state.status !== 'running') {
      clearCopyTriggers(sessionId);
      if (triggerUid) clearCopyTriggersById(triggerUid);
      promoteQueuedSessions();
      return;
    }
    continueCopy(sessionId);
  } catch(err) {
    if (sessionId) markCopySessionError(sessionId, err);
  }
}

function getCopyStatus(sessionId) {
  const sessions = getCopySessions();
  const selected = sessionId
    ? buildCopySessionStatus(sessionId)
    : chooseCopySessionForStatus(sessions);
  const activeCount = sessions.filter(function(session) {
    return isActiveCopyStatus(session.status);
  }).length;
  const queuedCount = sessions.filter(function(session) {
    return session.status === 'queued';
  }).length;
  const status = selected || {
    sessionId: '',
    status: 'idle',
    running: false,
    hasState: false,
    hasTrigger: false,
    triggerCount: 0,
    triggerIds: [],
    source: '',
    destName: '',
    name: '',
    current: '',
    files: 0,
    folders: 0,
    bytesCopied: 0,
    errors: [],
    startedAt: null,
    updatedAt: null,
    nextTriggerAt: null
  };
  status.sessions = sessions;
  status.activeCount = activeCount;
  status.queuedCount = queuedCount;
  status.maxParallelSessions = COPY_MAX_PARALLEL_SESSIONS;
  return status;
}

function getCopySessions() {
  return getCopySessionIds()
    .map(function(sessionId) { return buildCopySessionStatus(sessionId); })
    .filter(function(session) { return !!session; });
}

function getTriggerDashboard() {
  const triggers = getProjectTriggerDetails();
  const sessions = getCopySessions();
  const copyStatus = getCopyStatus();
  return {
    checkedAt: Date.now(),
    copyStatus: copyStatus,
    sessions: sessions,
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
      parallelCopyEnabled: true,
      maxParallelSessions: COPY_MAX_PARALLEL_SESSIONS,
      stateKey: COPY_SESSION_STATE_PREFIX + '{sessionId}',
      progressKey: COPY_SESSION_PROGRESS_PREFIX + '{sessionId}',
      reason: 'Mỗi phiên copy có sessionId, progress và trigger riêng; quá ' + COPY_MAX_PARALLEL_SESSIONS + ' phiên sẽ tự vào hàng chờ.'
    }
  };
}

function cancelCopy(sessionId) {
  sessionId = normalizeCopySessionId(sessionId, false) || (chooseCopySessionForStatus(getCopySessions()) || {}).sessionId;
  if (!sessionId) return getCopyStatus();

  const state = getCopyState(sessionId);
  const progress = getProgress(sessionId);
  clearCopyTriggers(sessionId);
  clearCopyState(sessionId);

  setProgress({
    done: (progress && typeof progress.done === 'number') ? progress.done : (state ? state.files : 0),
    total: 0,
    current: 'Đã hủy phiên copy nền.',
    name: (progress && progress.name) || (state && state.name) || '',
    source: (progress && progress.source) || (state && state.source) || '',
    destName: (progress && progress.destName) || (state && state.destName) || '',
    type: (progress && progress.type) || (state && state.type) || '',
    folders: (progress && typeof progress.folders === 'number') ? progress.folders : (state ? state.folders : 0),
    bytesCopied: (progress && typeof progress.bytesCopied === 'number') ? progress.bytesCopied : (state ? state.bytesCopied || 0 : 0),
    errors: (progress && progress.errors) || (state && state.errors) || [],
    status: 'cancelled'
  }, sessionId);

  promoteQueuedSessions();
  return getCopyStatus(sessionId);
}

function resumeCopyNow(sessionId) {
  sessionId = normalizeCopySessionId(sessionId, false) || findNextRunnableSessionId();
  if (!sessionId) return getCopyStatus();

  const state = getCopyState(sessionId);
  if (state && state.status === 'queued') {
    if (getActiveCopySessions().length >= COPY_MAX_PARALLEL_SESSIONS) {
      return getCopyStatus(sessionId);
    }
    activateCopySession(state, false);
  } else if (!state || state.status !== 'running') {
    return getCopyStatus(sessionId);
  }
  continueCopy(sessionId);
  return getCopyStatus(sessionId);
}

function finishCopy(result, state) {
  const sessionId = result.sessionId || (state && state.sessionId) || '';
  setProgress({
    sessionId: sessionId,
    done: result.files,
    total: result.files || 1,
    current: 'Hoàn thành',
    name: result.name,
    source: state ? state.source : '',
    destName: state ? state.destName : '',
    type: state ? state.type : '',
    folders: result.folders || 0,
    bytesCopied: result.bytesCopied || 0,
    errors: result.errors || [],
    status: 'done'
  }, sessionId);

  saveHistory({
    date: new Date().toLocaleString('vi-VN'),
    source: state ? state.source : '',
    dest: state ? state.destName : '',
    type: state ? state.type : '',
    name: result.name,
    files: result.files,
    folders: result.folders,
    bytesCopied: result.bytesCopied || 0,
    errors: (result.errors || []).length
  });
  clearCopyTriggers(sessionId);
  clearCopyState(sessionId);
  promoteQueuedSessions();
}

function stateToRunningResult(state) {
  return stateToResult(state, 'running');
}

function stateToQueuedResult(state) {
  return stateToResult(state, 'queued');
}

function stateToCancelledResult(state) {
  state.status = 'cancelled';
  return stateToResult(state, 'cancelled');
}

function stateToResult(state, status) {
  return {
    sessionId: state.sessionId,
    name: state.name,
    files: state.files || 0,
    folders: state.folders || 0,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors || [],
    status: status,
    queueReason: state.queueReason || '',
    nextTriggerAt: state.nextTriggerAt || null
  };
}

function createCopySessionState(input) {
  const now = Date.now();
  return {
    sessionId: input.sessionId,
    status: 'running',
    source: input.sourceUrl,
    sourceId: input.sourceId,
    destFolderId: input.destFolderId,
    destName: input.destName,
    type: input.type,
    name: input.name,
    overwriteMode: input.overwriteMode,
    startMode: input.startMode,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    nextTriggerAt: null,
    triggerId: '',
    leaseId: '',
    leaseUntil: 0,
    lastCurrent: 'Đang chuẩn bị copy theo lô...',
    queueReason: '',
    files: 0,
    bytesCopied: 0,
    folders: 0,
    errors: [],
    stack: []
  };
}

function activateCopySession(state, scheduleOnly) {
  state.status = 'running';
  state.startedAt = state.startedAt || Date.now();
  state.updatedAt = Date.now();
  state.queueReason = '';
  state.lastCurrent = scheduleOnly ? 'Đã có slot, đang chờ trigger chạy...' : 'Đang chuẩn bị copy theo lô...';

  if (state.type === 'folder' && (!state.stack || !state.stack.length)) {
    const src = DriveApp.getFolderById(state.sourceId);
    const destFolder = state.destFolderId === 'root'
      ? DriveApp.getRootFolder()
      : DriveApp.getFolderById(state.destFolderId);
    const rootDest = prepareDestinationFolder(src.getName(), destFolder, state.overwriteMode);
    state.folders = 1;
    state.stack = [{
      srcId: src.getId(),
      destId: rootDest.getId(),
      phase: 'files',
      filesToken: null,
      subsToken: null
    }];
  }

  if (scheduleOnly) {
    const scheduled = scheduleCopyTrigger(state.sessionId);
    state.triggerId = scheduled.triggerId;
    state.nextTriggerAt = scheduled.nextTriggerAt;
  }

  saveCopyState(state);
  setProgress({
    done: state.files || 0,
    total: state.type === 'file' ? 1 : 0,
    current: state.lastCurrent,
    name: state.name,
    source: state.source,
    destName: state.destName,
    type: state.type,
    folders: state.folders || 0,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors || [],
    status: 'running',
    nextTriggerAt: state.nextTriggerAt || null
  }, state.sessionId);
  return state;
}

function promoteQueuedSessions() {
  let activeSessions = getActiveCopySessions();
  const queuedSessions = getQueuedCopySessions();
  queuedSessions.forEach(function(state) {
    if (activeSessions.length >= COPY_MAX_PARALLEL_SESSIONS) return;
    try {
      const activated = activateCopySession(state, true);
      activeSessions.push(activated);
    } catch(e) {
      markCopySessionError(state.sessionId, e);
    }
  });
}

function getActiveCopySessions() {
  return getCopySessionIds()
    .map(function(sessionId) { return getCopyState(sessionId); })
    .filter(function(state) { return state && isActiveCopyStatus(state.status); });
}

function getQueuedCopySessions() {
  return getCopySessionIds()
    .map(function(sessionId) { return getCopyState(sessionId); })
    .filter(function(state) { return state && state.status === 'queued'; });
}

function isActiveCopyStatus(status) {
  return status === 'running' || status === 'starting';
}

function chooseCopySessionForStatus(sessions) {
  if (!sessions || !sessions.length) return null;
  const running = sessions.filter(function(session) { return isActiveCopyStatus(session.status); });
  if (running.length) return running[running.length - 1];
  const queued = sessions.filter(function(session) { return session.status === 'queued'; });
  if (queued.length) return queued[0];
  return sessions[sessions.length - 1];
}

function buildCopySessionStatus(sessionId) {
  sessionId = normalizeCopySessionId(sessionId, false);
  if (!sessionId) return null;
  const state = getCopyState(sessionId);
  const progress = getProgress(sessionId);
  if (!state && !progress) return null;
  const triggers = getCopyTriggersForSession(sessionId);
  const progressStatus = progress && progress.status ? progress.status : '';
  const stateStatus = state && state.status ? state.status : '';
  const status = progressStatus || stateStatus || (triggers.length ? 'running' : 'idle');
  return {
    sessionId: sessionId,
    status: status,
    running: isActiveCopyStatus(status),
    hasState: !!state,
    hasTrigger: triggers.length > 0,
    triggerCount: triggers.length,
    triggerHandler: COPY_TRIGGER_HANDLER,
    triggerIds: triggers.map(function(trigger) { return trigger.id; }),
    source: (progress && progress.source) || (state && state.source) || '',
    destName: (progress && progress.destName) || (state && state.destName) || '',
    name: (progress && progress.name) || (state && state.name) || '',
    current: (progress && progress.current) || (state && state.lastCurrent) || '',
    files: (progress && typeof progress.done === 'number') ? progress.done : (state ? state.files : 0),
    folders: (progress && typeof progress.folders === 'number') ? progress.folders : (state ? state.folders : 0),
    bytesCopied: (progress && typeof progress.bytesCopied === 'number') ? progress.bytesCopied : (state ? state.bytesCopied || 0 : 0),
    errors: (progress && progress.errors) || (state && state.errors) || [],
    queueReason: (progress && progress.queueReason) || (state && state.queueReason) || '',
    createdAt: state ? state.createdAt || null : null,
    startedAt: state ? state.startedAt || null : null,
    updatedAt: (progress && progress._ts) || (state && state.updatedAt) || null,
    nextTriggerAt: state ? state.nextTriggerAt || null : null
  };
}

function markCopySessionError(sessionId, error) {
  const message = error && error.message ? error.message : String(error || 'Lỗi không xác định');
  const state = getCopyState(sessionId);
  if (state) {
    state.status = 'error';
    state.updatedAt = Date.now();
    state.lastCurrent = message;
    state.errors = state.errors || [];
    rememberCopyError(state, '❌ ' + message);
    saveCopyState(state);
  }
  clearCopyTriggers(sessionId);
  setProgress({
    done: state ? state.files || 0 : 0,
    total: 0,
    current: message,
    name: state ? state.name : '',
    source: state ? state.source : '',
    destName: state ? state.destName : '',
    type: state ? state.type : '',
    folders: state ? state.folders || 0 : 0,
    bytesCopied: state ? state.bytesCopied || 0 : 0,
    errors: state ? state.errors || [message] : [message],
    status: 'error'
  }, sessionId);
  promoteQueuedSessions();
}

function normalizeCopyStartMode(startMode) {
  return startMode === COPY_START_PARALLEL ? COPY_START_PARALLEL : COPY_START_WAIT;
}

function normalizeCopySessionId(sessionId, createIfMissing) {
  sessionId = String(sessionId || '').trim();
  if (!sessionId && createIfMissing) return generateCopySessionId();
  if (!sessionId) return '';
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function generateCopySessionId() {
  try {
    return 's_' + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
  } catch(e) {
    return 's_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  }
}

function findNextRunnableSessionId() {
  const states = getCopySessionIds()
    .map(function(sessionId) { return getCopyState(sessionId); })
    .filter(function(state) { return state && state.status === 'running'; });
  if (!states.length) return '';
  states.sort(function(a, b) {
    return (a.nextTriggerAt || a.updatedAt || 0) - (b.nextTriggerAt || b.updatedAt || 0);
  });
  return states[0].sessionId;
}

function findSessionIdByTriggerUid(triggerUid) {
  triggerUid = String(triggerUid || '');
  if (!triggerUid) return '';
  const states = getCopySessionIds()
    .map(function(sessionId) { return getCopyState(sessionId); })
    .filter(function(state) { return !!state; });
  for (let i = 0; i < states.length; i++) {
    if (states[i].triggerId === triggerUid) return states[i].sessionId;
  }
  return '';
}

function isCopyCancelled(state) {
  const liveState = getCopyState(state.sessionId);
  return !liveState || liveState.status !== 'running' || liveState.startedAt !== state.startedAt;
}

function acquireCopySessionLease(sessionId) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    const state = getCopyState(sessionId);
    return state ? { busy: true, state: state } : null;
  }
  try {
    const state = getCopyState(sessionId);
    if (!state || state.status !== 'running') return null;
    const now = Date.now();
    if (state.leaseUntil && state.leaseUntil > now) {
      return { busy: true, state: state };
    }
    const leaseId = generateCopySessionId();
    state.leaseId = leaseId;
    state.leaseUntil = now + COPY_BATCH_MS + 60000;
    state.updatedAt = now;
    saveCopyState(state);
    return { busy: false, state: state, leaseId: leaseId };
  } finally {
    lock.releaseLock();
  }
}

function releaseCopySessionLease(sessionId, leaseId) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return;
  try {
    const state = getCopyState(sessionId);
    if (!state || state.leaseId !== leaseId) return;
    state.leaseId = '';
    state.leaseUntil = 0;
    state.updatedAt = Date.now();
    saveCopyState(state);
  } finally {
    lock.releaseLock();
  }
}

function scheduleCopyTrigger(sessionId) {
  clearCopyTriggers(sessionId);
  const nextTriggerAt = Date.now() + COPY_TRIGGER_DELAY_MS;
  const trigger = ScriptApp.newTrigger(COPY_TRIGGER_HANDLER)
    .timeBased()
    .after(COPY_TRIGGER_DELAY_MS)
    .create();
  return {
    triggerId: safeTriggerValue(function() { return trigger.getUniqueId(); }),
    nextTriggerAt: nextTriggerAt
  };
}

function clearCopyTriggers(sessionId) {
  sessionId = normalizeCopySessionId(sessionId, false);
  const state = sessionId ? getCopyState(sessionId) : null;
  const triggerId = state && state.triggerId ? state.triggerId : '';
  if (!sessionId) return;
  if (triggerId) clearCopyTriggersById(triggerId);
  if (state) {
    state.triggerId = '';
    state.nextTriggerAt = null;
    saveCopyState(state);
  }
}

function clearCopyTriggersById(triggerId) {
  triggerId = String(triggerId || '');
  if (!triggerId) return;
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    const id = safeTriggerValue(function() { return trigger.getUniqueId(); });
    const handler = safeTriggerValue(function() { return trigger.getHandlerFunction(); });
    if (handler === COPY_TRIGGER_HANDLER && id === triggerId) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function getCopyTriggerCount() {
  return getProjectTriggerDetails().filter(function(trigger) {
    return trigger.handler === COPY_TRIGGER_HANDLER;
  }).length;
}

function getCopyTriggersForSession(sessionId) {
  const state = getCopyState(sessionId);
  if (!state || !state.triggerId) return [];
  return getProjectTriggerDetails().filter(function(trigger) {
    return trigger.id === state.triggerId;
  });
}

function getProjectTriggerDetails() {
  const triggers = ScriptApp.getProjectTriggers();
  return triggers.map(function(trigger) {
    const id = safeTriggerValue(function() { return trigger.getUniqueId(); });
    const handler = safeTriggerValue(function() { return trigger.getHandlerFunction(); });
    const sessionId = handler === COPY_TRIGGER_HANDLER ? findSessionIdByTriggerUid(id) : '';
    return {
      id: id,
      handler: handler,
      eventType: safeTriggerValue(function() { return String(trigger.getEventType()); }),
      source: safeTriggerValue(function() { return String(trigger.getTriggerSource()); }),
      sourceId: safeTriggerValue(function() { return trigger.getTriggerSourceId(); }),
      sessionId: sessionId,
      isCopyTrigger: handler === COPY_TRIGGER_HANDLER
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
  const scheduled = scheduleCopyTrigger(state.sessionId);
  state.triggerId = scheduled.triggerId;
  state.nextTriggerAt = scheduled.nextTriggerAt;
  saveCopyState(state);
  setProgress({
    sessionId: state.sessionId,
    done: state.files,
    total: 0,
    current: state.lastCurrent,
    name: state.name,
    source: state.source,
    destName: state.destName,
    type: state.type,
    folders: state.folders || 0,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors,
    status: 'running',
    nextTriggerAt: state.nextTriggerAt
  }, state.sessionId);
  return stateToRunningResult(state);
}

function processCopyState(state) {
  if (state.type === 'file') return processSingleFileState(state);

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
            sessionId: state.sessionId,
            done: state.files,
            total: 0,
            current: f.getName(),
            name: state.name,
            source: state.source,
            destName: state.destName,
            type: state.type,
            folders: state.folders || 0,
            bytesCopied: state.bytesCopied || 0,
            errors: state.errors,
            status: 'running'
          }, state.sessionId);
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
            sessionId: state.sessionId,
            done: state.files,
            total: 0,
            current: '📁 ' + sub.getName(),
            name: state.name,
            source: state.source,
            destName: state.destName,
            type: state.type,
            folders: state.folders || 0,
            bytesCopied: state.bytesCopied || 0,
            errors: state.errors,
            status: 'running'
          }, state.sessionId);
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
  return {
    sessionId: state.sessionId,
    name: state.name,
    files: state.files,
    folders: state.folders,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors,
    status: 'done'
  };
}

function processSingleFileState(state) {
  if (isCopyCancelled(state)) return stateToCancelledResult(state);
  const src = DriveApp.getFileById(state.sourceId);
  const destFolder = state.destFolderId === 'root'
    ? DriveApp.getRootFolder()
    : DriveApp.getFolderById(state.destFolderId);
  setProgress({
    sessionId: state.sessionId,
    done: 0,
    total: 1,
    current: src.getName(),
    name: state.name,
    source: state.source,
    destName: state.destName,
    type: state.type,
    folders: 0,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors || [],
    status: 'running'
  }, state.sessionId);
  const fileSize = src.getSize();
  const copyStatus = copySingleFile(src, destFolder, state.overwriteMode);
  state.files = 1;
  state.folders = 0;
  state.bytesCopied = copyStatus === 'skipped' ? 0 : fileSize;
  state.status = 'done';
  return {
    sessionId: state.sessionId,
    name: state.name,
    files: state.files,
    folders: 0,
    bytesCopied: state.bytesCopied || 0,
    errors: state.errors || [],
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
