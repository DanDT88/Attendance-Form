/**
 * Google Apps Script backend for the Corporate Attendance Portal.
 *
 * This file is the source of truth for the server side. It is NOT deployed from
 * GitHub — paste it into the bound Apps Script project and redeploy via
 * Deploy > Manage deployments > (edit existing) > New version, so the /exec URL
 * stays the same as APPS_SCRIPT_URL in index.html and sw.js.
 */

/**
 * doNOT change this function name - required for GAS Web Apps
 * Kept for reference / fallback — you can still open this URL directly in a browser.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Corporate Attendance Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

/**
 * JSON API entry point used by the GitHub Pages front end.
 * The front end POSTs { action: "login" | "getStaff" | "getReplacementPool" | "commit", ...data }
 * as text/plain (avoids a CORS preflight, which Apps Script doesn't handle).
 */
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    let result;
    switch (req.action) {
      case 'login':
        result = portal_verifyUser(req.user, req.pass);
        break;
      case 'getStaff':
        result = portal_getFilteredStaff(req.comp, req.reg, req.site);
        break;
      case 'getReplacementPool':
        result = portal_getReplacementPool();
        break;
      case 'commit':
        result = portal_commitAttendanceRow(req.payload, req.isLateEntry, req.skipEmail, req.isEarlyEntry);
        break;
      case 'endShift':
        result = portal_commitEndShift(req.payload);
        break;

      // --- Admin dashboard (admin.html) ---
      case 'adminLogin':
        result = portal_verifyAdmin(req.user, req.pass);
        break;
      case 'getAttendanceByDateRange':
        result = portal_getAttendanceByDateRange(req);
        break;
      case 'getSiteLocations':
        result = portal_getSiteLocations();
        break;
      case 'getSubmissionPhotos':
        result = portal_getSubmissionPhotos(req);
        break;
      case 'getAllEmployees':
        result = portal_getAllEmployees();
        break;
      case 'addEmployee':
        result = portal_addEmployee(req.employee);
        break;
      case 'updateEmployee':
        result = portal_updateEmployee(req.employee);
        break;
      case 'deactivateEmployee':
        result = portal_deactivateEmployee(req);
        break;
      case 'getAllReplacements':
        result = portal_getAllReplacements();
        break;
      case 'addReplacement':
        result = portal_addReplacement(req.replacement);
        break;
      case 'updateReplacement':
        result = portal_updateReplacement(req.replacement);
        break;
      case 'deleteReplacement':
        result = portal_deleteReplacement(req);
        break;

      default:
        throw new Error('Unknown action: ' + req.action);
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "Error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Helper function to fix Logout Redirect
 * Returns the URL of the current Web App deployment
 */
function getScriptUrl() {
  return ScriptApp.getService().getUrl();
}

/** Case-Insensitive Login */
function portal_verifyUser(u, p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Users');
  const data = sheet.getDataRange().getValues();
  const inputUser = u.toString().toLowerCase().trim();
  const inputPass = p.toString().toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    const storedUser = data[i][0].toString().toLowerCase().trim();
    const storedPass = data[i][1].toString().toLowerCase().trim();
    if (storedUser === inputUser && storedPass === inputPass) {
      return { status: "Success", comp: data[i][2], reg: data[i][3], site: data[i][4], user: data[i][0] };
    }
  }
  return { status: "Error", message: "Invalid credentials." };
}

/** Deep clean site fetching - Updated to include employee region */
function portal_getFilteredStaff(c, r, s) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Employees');
  if (!sheet) return [];
  const data = sheet.getDataRange().getDisplayValues();
  const deepClean = (val) => val.toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const targetComp = deepClean(c);
  const targetReg = deepClean(r);
  const targetSite = deepClean(s);
  const filtered = data.filter((row, idx) => {
    if (idx === 0) return false;
    const rowComp = deepClean(row[2]);
    const rowReg  = deepClean(row[3]);
    const rowSite = deepClean(row[4]);
    // Deactivated staff drop off the mobile app's list. A blank Status column
    // counts as active, so employees added before the column existed stay put.
    if (!isActiveStatus(row[EMPLOYEE_STATUS_COL - 1])) return false;
    return rowComp === targetComp && rowReg === targetReg && rowSite === targetSite;
  });
  /* Added reg property to return object */
  return filtered.map(row => ({ name: row[0] + " " + row[1], title: row[5] || "Staff", reg: row[3] }));
}

/** Fetches replacement pool from separate tab */
function portal_getReplacementPool() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('ReplacementPool');
  if (!sheet) return { regions: [], allStaff: [] };
  const data = sheet.getDataRange().getDisplayValues();
  // Deactivated pool members drop off the mobile app's replacement picker.
  const active = data.slice(1).filter(row => isActiveStatus(row[REPLACEMENT_STATUS_COL - 1]));
  const regions = [...new Set(active.map(row => row[3]))].filter(r => r !== "").sort();
  const allStaff = active.map(row => ({ name: row[0] + " " + row[1], region: row[3] }));
  return { regions: regions, allStaff: allStaff };
}

/**
 * The full Attendance header, in column order. Columns 1-18 are the original
 * layout, 19-20 were added with the end-of-shift photos, and 21-30 hold the
 * per-photo compliance data. Only ever APPEND to this — existing columns are
 * addressed by index throughout this file and in the dashboard.
 */
const ATTENDANCE_HEADERS = [
  "Timestamp", "Date", "Shift", "Company", "Region", "Site", "Employee", "Status",
  "Reason/Duration", "Replacement", "Supervisor", "Sign-off Name", "SupPhoto",
  "StaffPhotoCount", "SubmissionID", "Shift Type", "End Shift Time", "End Shift SubmissionID",
  "End Shift SupPhoto", "End Shift StaffPhoto",
  "SupLat", "SupLng", "SupCaptureTime", "SupGeoOK", "SupTimeOK",
  "StaffLat", "StaffLng", "StaffCaptureTime", "StaffGeoOK", "StaffTimeOK"
];

/** A photo taken more than this far from its site is flagged. */
const GEO_TOLERANCE_METERS = 1000;
/** A photo taken more than this far from shift start is flagged. */
const SHIFT_GRACE_MINS = 30;
/** Written instead of true/false when compliance genuinely can't be determined. */
const COMPLIANCE_UNKNOWN = "Unknown";

/**
 * Soft-delete status columns, appended after each sheet's existing data.
 * Employees: A-F are First, Last, Company, Region, Site, Title -> Status is G.
 * ReplacementPool: A-D are First, Last, Company, Region -> Status is E.
 * A blank cell means Active, so every pre-existing row stays visible.
 */
const EMPLOYEE_STATUS_COL = 7;
const REPLACEMENT_STATUS_COL = 5;

/** True unless the row has been explicitly deactivated. Blank counts as active. */
function isActiveStatus(v) {
  return deepCleanValue(v) !== 'inactive';
}

/** Lowercase + trim, for the case-insensitive matching used across this file. */
function deepCleanValue(v) {
  return (v || "").toString().toLowerCase().trim();
}

/**
 * Sheets turns a "yyyy-MM-dd" string into a real Date on write, so it reads back
 * as a Date, not the original string. Normalize both sides the same way before
 * comparing, or every match silently fails.
 */
function normalizeSheetDate(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  return (v || "").toString().trim();
}

/** "HH:MM" -> minutes since midnight, or null if unparseable. */
function timeToMins(t) {
  if (!t) return null;
  const bits = t.toString().split(':').map(Number);
  if (bits.length < 2 || isNaN(bits[0]) || isNaN(bits[1])) return null;
  return bits[0] * 60 + bits[1];
}

/**
 * Shortest distance between two clock times, in minutes, wrapping around
 * midnight — so 23:50 and 00:10 are 20 minutes apart, not 1420.
 */
function clockDiffMins(a, b) {
  const raw = Math.abs(a - b);
  return Math.min(raw, 1440 - raw);
}

/**
 * Looks for a row that already has this submissionId in the given column.
 * Used to make commits idempotent: if a client retries a submission that
 * actually succeeded server-side (e.g. after a client-side timeout), we
 * detect the duplicate here and skip re-writing rows / re-sending the email.
 */
function findExistingSubmissionRow(sheet, submissionId, colIndex) {
  if (!submissionId) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const finder = sheet.getRange(2, colIndex, lastRow - 1, 1).createTextFinder(submissionId).matchEntireCell(true);
  const match = finder.findNext();
  return match ? match.getRow() : null;
}

/**
 * A full base64 data URL is far too big for a sheet cell in most cases, so only
 * small ones are stored inline; anything bigger is left as a pointer to the email
 * copy. Shared by the register commit and the end-of-shift closeout.
 */
function cleanPhotoForSheet(img) {
  return (img && img.length < 48000) ? img : "Image in Email";
}

/**
 * Turns a "data:image/jpeg;base64,..." string into a Gmail inline-image blob.
 * Returns null instead of throwing on a missing or malformed value, so one bad
 * photo can't abort a closeout whose sheet rows have already been written.
 */
function photoToBlob(dataUrl, filename) {
  if (!dataUrl) return null;
  const parts = dataUrl.toString().split(',');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return Utilities.newBlob(Utilities.base64Decode(parts[1]), "image/jpeg", filename);
  } catch (e) {
    return null;
  }
}

/**
 * Computes how many minutes before shift end an employee left, given the
 * "HH:MM-HH:MM" shift range and the time they left. Handles overnight shifts
 * (e.g. 18:30-03:30) the same way the front-end lateness calc does — by
 * pushing times past midnight when the shift crosses it.
 * Returns null if inputs are missing/unparseable.
 */
function computeEarlyDurationMins(shiftRange, timeLeft) {
  if (!shiftRange || !timeLeft) return null;
  const parts = shiftRange.split('-');
  if (parts.length < 2) return null;
  const startMins = timeToMins(parts[0]);
  let endMins = timeToMins(parts[1]);
  let leftMins = timeToMins(timeLeft);
  if (startMins === null || endMins === null || leftMins === null) return null;
  const isOvernightShift = endMins <= startMins;
  if (isOvernightShift) {
    if (endMins <= startMins) endMins += 1440;
    if (leftMins < startMins) leftMins += 1440;
  }
  const diff = endMins - leftMins;
  return diff > 0 ? diff : 0;
}

/**
 * The Attendance header row is only written when the sheet is brand new, so a
 * sheet created before the later columns existed has neither the physical
 * columns nor the labels for them. Widen it and fill in any blank header cell.
 * Existing headers and data are never overwritten. A default sheet is 26 columns
 * wide, so this is what stops a 30-column setValues from throwing.
 */
function ensureAttendanceColumns(sheet) {
  const needed = ATTENDANCE_HEADERS.length;
  if (sheet.getMaxColumns() < needed) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) return; // brand new — the caller's appendRow writes the full header
  const headerRange = sheet.getRange(1, 1, 1, needed);
  const header = headerRange.getValues()[0];
  let changed = false;
  for (let i = 0; i < needed; i++) {
    if (!header[i]) { header[i] = ATTENDANCE_HEADERS[i]; changed = true; }
  }
  if (changed) headerRange.setValues([header]);
}

/**
 * Case-insensitive admin login against the AdminUsers sheet.
 * Deliberately separate from portal_verifyUser / the Users sheet — supervisor
 * credentials must not grant head-office access.
 */
function portal_verifyAdmin(u, p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('AdminUsers');
  if (!sheet) return { status: "Error", message: "No AdminUsers sheet found." };
  const data = sheet.getDataRange().getValues();
  const inputUser = (u || "").toString().toLowerCase().trim();
  const inputPass = (p || "").toString().toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    const storedUser = (data[i][0] || "").toString().toLowerCase().trim();
    const storedPass = (data[i][1] || "").toString().toLowerCase().trim();
    if (storedUser && storedUser === inputUser && storedPass === inputPass) {
      return { status: "Success", user: data[i][0], name: data[i][2] || data[i][0] };
    }
  }
  return { status: "Error", message: "Invalid credentials." };
}

/**
 * Looks up a site's coordinates in the SiteLocations sheet (Site | Latitude | Longitude).
 * Returns {lat, lng} or null when the sheet or the site is missing, or the row
 * has no usable numbers — callers treat null as "can't verify", not "failed".
 */
function getSiteCoordinates(siteName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('SiteLocations');
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  const target = deepCleanValue(siteName);
  if (!target) return null;
  for (let i = 1; i < data.length; i++) {
    if (deepCleanValue(data[i][0]) === target) {
      const lat = parseFloat(data[i][1]);
      const lng = parseFloat(data[i][2]);
      if (isNaN(lat) || isNaN(lng)) return null;
      return { lat: lat, lng: lng };
    }
  }
  return null;
}

/** Great-circle distance between two points, in meters. */
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Was this photo taken within SHIFT_GRACE_MINS of the shift starting?
 * Returns true/false, or null when it can't be determined.
 *
 * shiftType is accepted because the caller knows it and the rule may yet differ
 * by shift, but it is not needed for the arithmetic: clockDiffMins measures the
 * shortest distance around the clock face, which handles a night shift crossing
 * midnight on its own. Note this is deliberately NOT the same midnight handling
 * as computeEarlyDurationMins — that one measures a signed duration across a
 * shift and must push past midnight; this is a symmetric +/- window, where
 * pushing past midnight would wrongly flag a photo taken slightly BEFORE start.
 * The two share timeToMins, which is the part that must not drift.
 */
function isWithinShiftGracePeriod(shiftStart, shiftType, captureTimestamp) {
  const startMins = timeToMins(shiftStart);
  if (startMins === null || !captureTimestamp) return null;
  const captured = new Date(captureTimestamp);
  if (isNaN(captured.getTime())) return null;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const captureMins = timeToMins(Utilities.formatDate(captured, tz, "HH:mm"));
  if (captureMins === null) return null;
  return clockDiffMins(startMins, captureMins) <= SHIFT_GRACE_MINS;
}

/**
 * Builds the 10 compliance values (columns 21-30) for one register submission.
 * Both photos are evaluated independently. Anything that can't be verified —
 * no coordinates from the device, no SiteLocations row, an unparseable
 * timestamp — is written as "Unknown" rather than false, so an unverifiable
 * submission is never silently recorded as compliant.
 *
 * This is independent of whether the image itself survived the 48k cell gate.
 */
function buildComplianceValues(payload) {
  const siteCoords = getSiteCoordinates(payload.site);
  const shiftStart = (payload.shift || "").toString().split('-')[0];

  const evaluate = (lat, lng, captureTime) => {
    const hasCoords = (lat !== undefined && lat !== null && lat !== "" && !isNaN(parseFloat(lat)) &&
                       lng !== undefined && lng !== null && lng !== "" && !isNaN(parseFloat(lng)));
    let geoOK = COMPLIANCE_UNKNOWN;
    if (hasCoords && siteCoords) {
      const dist = haversineDistanceMeters(parseFloat(lat), parseFloat(lng), siteCoords.lat, siteCoords.lng);
      geoOK = dist <= GEO_TOLERANCE_METERS;
    }
    const within = isWithinShiftGracePeriod(shiftStart, payload.shiftType, captureTime);
    const timeOK = (within === null) ? COMPLIANCE_UNKNOWN : within;
    return [
      hasCoords ? parseFloat(lat) : "",
      hasCoords ? parseFloat(lng) : "",
      captureTime || "",
      geoOK,
      timeOK
    ];
  };

  return evaluate(payload.supPhotoLat, payload.supPhotoLng, payload.supPhotoCaptureTime)
    .concat(evaluate(payload.staffPhotoLat, payload.staffPhotoLng, payload.staffPhotoCaptureTime));
}

/** portal_commitAttendanceRow */
function portal_commitAttendanceRow(payload, isLateEntry = false, skipEmail = false, isEarlyEntry = false) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let attSheet = ss.getSheetByName('Attendance') || ss.insertSheet('Attendance');
    let repSheet = ss.getSheetByName('Replacements') || ss.insertSheet('Replacements');

    if (attSheet.getLastRow() === 0) attSheet.appendRow(ATTENDANCE_HEADERS);
    if (repSheet.getLastRow() === 0) repSheet.appendRow(["Timestamp", "Date", "Region", "Site", "Absent Staff", "Replacement Name", "Reason", "Supervisor"]);
    ensureAttendanceColumns(attSheet);

    const SUBMISSION_ID_COL = 15; // column O — must match the header order above

    // --- IDEMPOTENCY GUARD ---
    // If this exact submission (same submissionId) already landed in the sheet,
    // it means a previous attempt succeeded but the client didn't get the
    // response in time and retried. Don't re-write rows or re-send the email.
    if (payload.submissionId) {
      const existingRow = findExistingSubmissionRow(attSheet, payload.submissionId, SUBMISSION_ID_COL);
      if (existingRow) {
        return { status: "Success", firstRow: existingRow, duplicate: true };
      }
    }

    const ts = new Date();
    const attRows = [];
    const repRows = [];
    let inlineImages = {};

    const sheetSupPhoto = cleanPhotoForSheet(payload.supPhoto);

    let emailHtml = `<div style="font-family: 'Segoe UI', Arial, sans-serif; color: #333; max-width: 700px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; background:#fff;">
      <div style="background-color: #1B365D; color: white; padding: 20px; text-align: center;">
        <h2 style="margin: 0; text-transform: uppercase;">Attendance Report Update</h2>
        <p style="margin: 5px 0 0 0;">${payload.site} | ${payload.date}</p>
      </div>
      <div style="padding: 20px;">
        <p><strong>Region:</strong> ${payload.reg}</p>
        <p><strong>Shift Type:</strong> ${payload.shiftType || "N/A"} (${payload.shift || "N/A"})</p>
        <p><strong>Supervisor Logged:</strong> ${payload.loggedUser}</p>
        <p><strong>Supervisor Sign-off:</strong> ${payload.signOffName || "N/A"}</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
          <thead>
            <tr style="background-color: #f8fafc; border-bottom: 2px solid #cbd5e1;">
              <th style="padding: 10px; text-align: left; font-size: 11px;">EMPLOYEE</th>
              <th style="padding: 10px; text-align: center; font-size: 11px;">STATUS</th>
              <th style="padding: 10px; text-align: left; font-size: 11px;">REASON / LATE</th>
              <th style="padding: 10px; text-align: left; font-size: 11px;">REPLACEMENT</th>
            </tr>
          </thead>
          <tbody>`;

    if (isLateEntry) {
      attRows.push([ts, payload.date, payload.shiftStart, payload.comp, payload.reg, payload.site, payload.empName, payload.status, payload.duration + " mins - " + (payload.reason || "No reason given"), "N/A", payload.loggedUser, payload.signOffName || "N/A", "", "1", payload.submissionId || "", payload.shiftType || ""]);
    } else if (isEarlyEntry) {
      // Single-employee commit from the "Left Early" tab (mirrors the Lateness tab's single-employee commit above).
      const detail = "Left at " + payload.timeLeft + " - " + (payload.reason || "No reason given");
      attRows.push([ts, payload.date, "", payload.comp, payload.reg, payload.site, payload.empName, "Left Early", detail, "N/A", payload.loggedUser, payload.signOffName || "N/A", "", "1", payload.submissionId || "", payload.shiftType || ""]);
    } else {
      // Computed once per submission — both photos belong to the whole register,
      // not to an individual employee row, so every row carries the same values.
      const complianceValues = buildComplianceValues(payload);
      payload.records.forEach(r => {
        let detail;
        if (r.status === 'Late') {
          detail = (r.lateDuration || "Late") + " - " + (r.lateReason || "No reason given");
        } else if (r.status === 'Left Early') {
          const earlyDurMins = computeEarlyDurationMins(payload.shift, r.earlyTimeLeft);
          const earlyDurText = (earlyDurMins !== null) ? ` (${earlyDurMins} mins early)` : "";
          detail = "Left at " + (r.earlyTimeLeft || "?") + earlyDurText + " - " + (r.earlyReason || "No reason given");
        } else {
          detail = r.absentReason || "N/A";
        }
        // Columns 1-16, then 4 blanks holding columns 17-20 (End Shift Time,
        // End Shift SubmissionID and the two end-of-shift photos, all filled in
        // later by portal_commitEndShift), then the 10 compliance values in 21-30.
        // The blanks are load-bearing: setValues writes from column 1, so without
        // them the compliance data would land on top of the End Shift columns.
        attRows.push([ts, payload.date, payload.shift, payload.comp, payload.reg, payload.site, r.name, r.status, detail, r.replacement || "N/A", payload.loggedUser, payload.signOffName, sheetSupPhoto, payload.staffPhotoCount, payload.submissionId || "", payload.shiftType || "", "", "", "", ""].concat(complianceValues));
        if (r.status === 'Absent' && r.replacement && r.replacement !== 'None') {
          repRows.push([ts, payload.date, payload.reg, payload.site, r.name, r.replacement, r.absentReason, payload.loggedUser]);
        }
        let color = (r.status === 'Present' || r.status === 'Left Early') ? '#38A169' : (r.status === 'Absent' ? '#E53E3E' : '#DD6B20');
        emailHtml += `<tr><td style="padding: 10px; border-bottom: 1px solid #eee;">${r.name}</td><td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center; color:${color};"><b>${r.status.toUpperCase()}</b></td><td style="padding: 10px; border-bottom: 1px solid #eee;">${detail}</td><td style="padding: 10px; border-bottom: 1px solid #eee;">${r.replacement || "N/A"}</td></tr>`;
      });
    }
    emailHtml += `</tbody></table>`;
    let pdfHtml = emailHtml; // snapshot before cid images are appended — the PDF version embeds images directly instead

    if (payload.supPhoto) {
      const supBlob = Utilities.newBlob(Utilities.base64Decode(payload.supPhoto.split(',')[1]), "image/jpeg", "sup.jpg");
      inlineImages["supImg"] = supBlob;
      emailHtml += `<div style="text-align: center; margin-top: 20px;"><img src="cid:supImg" style="width: 250px; border-radius: 8px;"/></div>`;
      pdfHtml += `<div style="text-align: center; margin-top: 20px;"><img src="${payload.supPhoto}" style="width: 250px; border-radius: 8px;"/></div>`;
    }
    if (payload.staffPhoto) {
      const staffBlob = Utilities.newBlob(Utilities.base64Decode(payload.staffPhoto.split(',')[1]), "image/jpeg", "staff.jpg");
      inlineImages["staffImg"] = staffBlob;
      emailHtml += `<div style="text-align: center; margin-top: 20px;"><img src="cid:staffImg" style="width: 250px; border-radius: 8px;"/></div>`;
      pdfHtml += `<div style="text-align: center; margin-top: 20px;"><img src="${payload.staffPhoto}" style="width: 250px; border-radius: 8px;"/></div>`;
    }
    emailHtml += `</div></div>`;
    pdfHtml += `</div></div>`;

    let startRow = payload.editFirstRow || (attSheet.getLastRow() + 1);
    if (attRows.length > 0) attSheet.getRange(startRow, 1, attRows.length, attRows[0].length).setValues(attRows);
    if (repRows.length > 0) repSheet.getRange(repSheet.getLastRow() + 1, 1, repRows.length, repRows[0].length).setValues(repRows);

    if (!skipEmail) {
      const pdfName = `Attendance_${payload.site}_${payload.date}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const pdfBlob = htmlToPdfBlob(pdfHtml, pdfName);
      const recipients = getRecipientsForCompany(payload.comp);
      GmailApp.sendEmail(recipients, `Attendance Summary: ${payload.site} (${payload.date})`, "", { htmlBody: emailHtml, inlineImages: inlineImages, attachments: [pdfBlob], name: "Delta Attendance Form" });
    }

    return { status: "Success", firstRow: startRow };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Closes out a day's shift. Called from the separate "End Shift" tab at the
 * end of the day. Matches rows by Date + Site + Company (not a client-side
 * row number), so it works even after a reload or a fresh login.
 *
 * For every matching row that isn't already closed out:
 *  - fills in the End Shift Time column
 *  - extends the Shift column from "HH:MM" to "HH:MM-HH:MM"
 *  - stores the end-of-shift verification photos
 *  - for anyone marked "Left Early", backfills the actual minutes-early into
 *    their Reason/Duration text now that the shift end time is known
 *
 * IMPORTANT — emails: this sends exactly ONE summary email per End Shift
 * submission, no matter how many employees are on the shift. All employees
 * are gathered into two lists (present till end / not present till end) in
 * memory first, then a single GmailApp.sendEmail call goes out at the very
 * end — never inside the per-row loop. A submissionId guard also stops a
 * network retry of the same submission from sending a second copy.
 */
function portal_commitEndShift(payload) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const attSheet = ss.getSheetByName('Attendance');
    if (!attSheet) return { status: "Error", message: "No Attendance sheet found yet — submit the morning register first." };
    const lastRow = attSheet.getLastRow();
    if (lastRow < 2) return { status: "Error", message: "No attendance rows found to close out." };

    const SHIFT_COL = 3, STATUS_COL = 8, REASON_COL = 9, END_SHIFT_COL = 17, END_SHIFT_SUB_COL = 18;
    const END_SUP_PHOTO_COL = 19, END_STAFF_PHOTO_COL = 20;

    ensureAttendanceColumns(attSheet);

    const numCols = Math.max(attSheet.getLastColumn(), ATTENDANCE_HEADERS.length);
    const data = attSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    const tz = ss.getSpreadsheetTimeZone();
    const normalizeDate = (v) => normalizeSheetDate(v, tz);
    const deepClean = deepCleanValue;
    const targetDate = normalizeDate(payload.date);
    const targetSite = deepClean(payload.site);
    const targetComp = deepClean(payload.comp);

    // Gather every row belonging to this shift first (open or already-closed), so the
    // summary email and the duplicate-submission check both see the full roster.
    const matchedRows = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (normalizeDate(row[1]) === targetDate && deepClean(row[5]) === targetSite && deepClean(row[3]) === targetComp) {
        matchedRows.push({ sheetRow: i + 2, row });
      }
    }
    if (matchedRows.length === 0) return { status: "Error", message: "No open shift found for that date/site to close out." };

    // --- IDEMPOTENCY GUARD ---
    // If this exact End Shift submission already went through (e.g. the client retried
    // after a timeout, or the offline queue re-sent it), don't touch rows again and,
    // critically, don't send a second copy of the summary email.
    if (payload.submissionId && matchedRows.some(m => deepClean(m.row[END_SHIFT_SUB_COL - 1]) === deepClean(payload.submissionId))) {
      return { status: "Success", updatedRows: matchedRows.length, duplicate: true };
    }

    const openRows = matchedRows.filter(m => !m.row[END_SHIFT_COL - 1]);
    if (openRows.length === 0) return { status: "Error", message: "This shift has already been closed out for that date/site." };

    // End-of-shift verification photos. Stored the same way the register stores its
    // own: small ones inline in the cell, larger ones left as a pointer to the email.
    const sheetEndSupPhoto = payload.endSupPhoto ? cleanPhotoForSheet(payload.endSupPhoto) : "";
    const sheetEndStaffPhoto = payload.endStaffPhoto ? cleanPhotoForSheet(payload.endStaffPhoto) : "";

    // --- Update every open row: fill in end time, extend shift range, store photos, backfill early-leave duration ---
    openRows.forEach(m => {
      const { sheetRow, row } = m;
      const startTime = (row[SHIFT_COL - 1] || "").toString().split('-')[0];
      const newShiftRange = startTime + "-" + payload.endTime;
      attSheet.getRange(sheetRow, SHIFT_COL).setValue(newShiftRange);
      attSheet.getRange(sheetRow, END_SHIFT_COL).setValue(payload.endTime);
      attSheet.getRange(sheetRow, END_SHIFT_SUB_COL).setValue(payload.submissionId || "");
      if (sheetEndSupPhoto) attSheet.getRange(sheetRow, END_SUP_PHOTO_COL).setValue(sheetEndSupPhoto);
      if (sheetEndStaffPhoto) attSheet.getRange(sheetRow, END_STAFF_PHOTO_COL).setValue(sheetEndStaffPhoto);

      if (deepClean(row[STATUS_COL - 1]) === 'left early') {
        const detailText = (row[REASON_COL - 1] || "").toString();
        const match = detailText.match(/^Left at (\d{1,2}:\d{2})(?: \(\d+ mins early\))? - (.*)$/);
        if (match) {
          const mins = computeEarlyDurationMins(newShiftRange, match[1]);
          const newDetail = "Left at " + match[1] + (mins !== null ? ` (${mins} mins early)` : "") + " - " + match[2];
          attSheet.getRange(sheetRow, REASON_COL).setValue(newDetail);
          row[REASON_COL - 1] = newDetail; // keep the in-memory copy in sync for the summary below
        }
      }
    });

    // --- Build the ONE combined summary from every matched row (present vs not-present) ---
    const presentTillEnd = [];
    const notPresentTillEnd = [];
    matchedRows.forEach(m => {
      const row = m.row;
      const status = deepClean(row[STATUS_COL - 1]);
      const name = row[6];
      const reason = (row[REASON_COL - 1] || "").toString();
      if (status === 'absent') {
        notPresentTillEnd.push({ name, note: "Absent — " + (reason || "No reason given") });
      } else if (status === 'left early') {
        notPresentTillEnd.push({ name, note: reason || "Left early" });
      } else if (status === 'late') {
        presentTillEnd.push({ name, note: "Arrived late — " + (reason || "No reason given") });
      } else {
        presentTillEnd.push({ name, note: "" });
      }
    });

    const renderList = (items, noteColor) => items.length
      ? `<ul style="margin:6px 0 0; padding-left:18px;">` + items.map(it =>
          `<li style="padding:3px 0; color:#333;"><b>${it.name}</b>${it.note ? ` <span style="color:${noteColor}; font-size:12px;">— ${it.note}</span>` : ""}</li>`
        ).join("") + `</ul>`
      : `<p style="margin:6px 0 0; color:#94A3B8; font-size:13px;">None</p>`;

    const anyRow = matchedRows[0].row;
    const site = anyRow[5], reg = anyRow[4], comp = anyRow[3];
    const shiftType = anyRow[15] || "N/A";

    // Attach the end-of-shift verification photos as inline images, the same way the
    // register email embeds its supervisor / group photos.
    const inlineImages = {};
    let photoHtml = "";
    const endSupBlob = photoToBlob(payload.endSupPhoto, "end_sup.jpg");
    if (endSupBlob) {
      inlineImages["endSupImg"] = endSupBlob;
      photoHtml += `<div style="text-align:center; margin-top:20px;"><p style="margin:0 0 6px; font-size:11px; font-weight:bold; color:#4A5568; text-transform:uppercase;">Supervisor</p><img src="cid:endSupImg" style="width:250px; border-radius:8px;"/></div>`;
    }
    const endStaffBlob = photoToBlob(payload.endStaffPhoto, "end_staff.jpg");
    if (endStaffBlob) {
      inlineImages["endStaffImg"] = endStaffBlob;
      photoHtml += `<div style="text-align:center; margin-top:20px;"><p style="margin:0 0 6px; font-size:11px; font-weight:bold; color:#4A5568; text-transform:uppercase;">Group Photo</p><img src="cid:endStaffImg" style="width:250px; border-radius:8px;"/></div>`;
    }
    if (photoHtml) {
      photoHtml = `<h3 style="margin:24px 0 0; color:#1B365D;">End of Shift Verification Photos</h3>` + photoHtml;
    }

    const emailHtml = `<div style="font-family:'Segoe UI',Arial,sans-serif; color:#333; max-width:700px; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; background:#fff;">
      <div style="background-color:#1B365D; color:white; padding:20px; text-align:center;">
        <h2 style="margin:0; text-transform:uppercase;">End of Shift Summary</h2>
        <p style="margin:5px 0 0 0;">${site} | ${payload.date}</p>
      </div>
      <div style="padding:20px;">
        <p><strong>Region:</strong> ${reg}</p>
        <p><strong>Shift Type:</strong> ${shiftType}</p>
        <p><strong>Shift End Time:</strong> ${payload.endTime}</p>
        <h3 style="margin:20px 0 0; color:#38A169;">Present Until End of Shift (${presentTillEnd.length})</h3>
        ${renderList(presentTillEnd, "#DD6B20")}
        <h3 style="margin:20px 0 0; color:#E53E3E;">Not Present Until End of Shift (${notPresentTillEnd.length})</h3>
        ${renderList(notPresentTillEnd, "#E53E3E")}
        ${photoHtml}
      </div>
    </div>`;

    // ONE email call for the entire shift roster — this is what keeps a 50-person
    // shift from firing off 50 separate emails.
    const recipients = getRecipientsForCompany(comp);
    GmailApp.sendEmail(recipients, `End of Shift Summary: ${site} (${payload.date})`, "", { htmlBody: emailHtml, inlineImages: inlineImages, name: "Delta Attendance Form" });

    return { status: "Success", updatedRows: openRows.length, presentCount: presentTillEnd.length, notPresentCount: notPresentTillEnd.length };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Returns Attendance rows in a date range as objects keyed to ATTENDANCE_HEADERS,
 * for the admin dashboard. Today's Overview, Reports & Trends and Compliance
 * Review all consume this one result set and aggregate it differently client-side.
 *
 * comp is required; reg and site are optional filters — omit them for everything.
 *
 * Photo columns are stripped unless includePhotos is true. A SupPhoto cell can be
 * 48,000 characters, so a week of a busy site would otherwise return megabytes of
 * base64 that the dashboard only needs when someone opens a single submission.
 */
function portal_getAttendanceByDateRange(req) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const attSheet = ss.getSheetByName('Attendance');
    if (!attSheet) return { status: "Success", rows: [] };
    const lastRow = attSheet.getLastRow();
    if (lastRow < 2) return { status: "Success", rows: [] };

    const tz = ss.getSpreadsheetTimeZone();
    const numCols = Math.max(attSheet.getLastColumn(), ATTENDANCE_HEADERS.length);
    const data = attSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    const startDate = normalizeSheetDate(req.startDate, tz);
    const endDate = normalizeSheetDate(req.endDate, tz);
    const targetComp = deepCleanValue(req.comp);
    const targetReg = deepCleanValue(req.reg);
    const targetSite = deepCleanValue(req.site);
    const includePhotos = req.includePhotos === true;
    const PHOTO_KEYS = ["SupPhoto", "End Shift SupPhoto", "End Shift StaffPhoto"];

    const rows = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowDate = normalizeSheetDate(row[1], tz);
      if (startDate && rowDate < startDate) continue;
      if (endDate && rowDate > endDate) continue;
      if (targetComp && deepCleanValue(row[3]) !== targetComp) continue;
      if (targetReg && deepCleanValue(row[4]) !== targetReg) continue;
      if (targetSite && deepCleanValue(row[5]) !== targetSite) continue;

      const obj = { sheetRow: i + 2 };
      for (let c = 0; c < ATTENDANCE_HEADERS.length; c++) {
        const key = ATTENDANCE_HEADERS[c];
        let val = row[c];
        if (!includePhotos && PHOTO_KEYS.indexOf(key) !== -1) {
          // Tell the dashboard whether an image exists without shipping it.
          obj[key + "Present"] = !!val && val !== "Image in Email";
          obj[key] = val === "Image in Email" ? "Image in Email" : "";
          continue;
        }
        if (val instanceof Date) val = (c === 1) ? normalizeSheetDate(val, tz) : val.toISOString();
        obj[key] = (val === null || val === undefined) ? "" : val;
      }
      rows.push(obj);
    }
    return { status: "Success", rows: rows };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * The SiteLocations reference table, so the dashboard can render "1.4km from
 * site" itself from the stored lat/lng rather than the backend having to store
 * a display string per row.
 */
function portal_getSiteLocations() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('SiteLocations');
    if (!sheet) return { status: "Success", rows: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: "Success", rows: [] };
    const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    const rows = data
      .map(r => ({ site: r[0], lat: parseFloat(r[1]), lng: parseFloat(r[2]) }))
      .filter(r => r.site && !isNaN(r.lat) && !isNaN(r.lng));
    return { status: "Success", rows: rows };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * The stored images for a single submission, fetched on demand when an admin
 * opens one in Compliance Review. Keeps getAttendanceByDateRange free of
 * base64 — a week of submissions would otherwise be megabytes of it.
 */
function portal_getSubmissionPhotos(req) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return { status: "Error", message: "No Attendance sheet found." };
    const row = findExistingSubmissionRow(sheet, req && req.submissionId, 15);
    if (!row) return { status: "Error", message: "Submission not found." };
    const vals = sheet.getRange(row, 1, 1, Math.max(sheet.getLastColumn(), ATTENDANCE_HEADERS.length)).getValues()[0];
    return {
      status: "Success",
      supPhoto: vals[12] || "",
      endSupPhoto: vals[18] || "",
      endStaffPhoto: vals[19] || ""
    };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Every employee, for the admin Staff Directory. Unlike portal_getFilteredStaff
 * this is unfiltered and includes deactivated people, so admins can see and
 * reactivate them. sheetRow is the stable handle used by update/deactivate.
 */
function portal_getAllEmployees() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Employees');
    if (!sheet) return { status: "Success", rows: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: "Success", rows: [] };
    const data = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), EMPLOYEE_STATUS_COL)).getValues();
    const rows = data.map((row, i) => ({
      sheetRow: i + 2,
      firstName: row[0], lastName: row[1], comp: row[2], reg: row[3], site: row[4],
      title: row[5] || "Staff",
      status: (row[EMPLOYEE_STATUS_COL - 1] || "").toString().trim() || "Active"
    })).filter(r => r.firstName || r.lastName);
    return { status: "Success", rows: rows };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/** Appends an employee. Status defaults to Active. */
function portal_addEmployee(emp) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Employees');
    if (!sheet) return { status: "Error", message: "No Employees sheet found." };
    if (!emp || !(emp.firstName || "").toString().trim()) return { status: "Error", message: "First name is required." };
    if (sheet.getMaxColumns() < EMPLOYEE_STATUS_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), EMPLOYEE_STATUS_COL - sheet.getMaxColumns());
    }
    const row = [emp.firstName || "", emp.lastName || "", emp.comp || "", emp.reg || "", emp.site || "", emp.title || "Staff", "Active"];
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    return { status: "Success", sheetRow: sheet.getLastRow() };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Updates one employee, addressed by sheetRow from portal_getAllEmployees.
 * Row numbers are a safe handle here precisely because deactivation is a soft
 * delete — rows are never removed, so indices don't shift under the dashboard.
 */
function portal_updateEmployee(emp) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Employees');
    if (!sheet) return { status: "Error", message: "No Employees sheet found." };
    const r = parseInt(emp && emp.sheetRow, 10);
    if (!r || r < 2 || r > sheet.getLastRow()) return { status: "Error", message: "That employee row no longer exists — reload the directory." };
    if (sheet.getMaxColumns() < EMPLOYEE_STATUS_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), EMPLOYEE_STATUS_COL - sheet.getMaxColumns());
    }
    const existing = sheet.getRange(r, 1, 1, EMPLOYEE_STATUS_COL).getValues()[0];
    const row = [
      emp.firstName !== undefined ? emp.firstName : existing[0],
      emp.lastName !== undefined ? emp.lastName : existing[1],
      emp.comp !== undefined ? emp.comp : existing[2],
      emp.reg !== undefined ? emp.reg : existing[3],
      emp.site !== undefined ? emp.site : existing[4],
      emp.title !== undefined ? emp.title : existing[5],
      emp.status !== undefined ? emp.status : (existing[6] || "Active")
    ];
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    return { status: "Success" };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Soft-deletes an employee by setting Status = Inactive. Never removes the row:
 * their name appears in historical Attendance records and must stay resolvable.
 * Pass reactivate: true to set them back to Active.
 */
function portal_deactivateEmployee(req) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Employees');
    if (!sheet) return { status: "Error", message: "No Employees sheet found." };
    const r = parseInt(req && req.sheetRow, 10);
    if (!r || r < 2 || r > sheet.getLastRow()) return { status: "Error", message: "That employee row no longer exists — reload the directory." };
    if (sheet.getMaxColumns() < EMPLOYEE_STATUS_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), EMPLOYEE_STATUS_COL - sheet.getMaxColumns());
    }
    sheet.getRange(r, EMPLOYEE_STATUS_COL).setValue(req.reactivate ? "Active" : "Inactive");
    return { status: "Success" };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/** Every replacement-pool member, including deactivated, for the admin directory. */
function portal_getAllReplacements() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('ReplacementPool');
    if (!sheet) return { status: "Success", rows: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: "Success", rows: [] };
    const data = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), REPLACEMENT_STATUS_COL)).getValues();
    const rows = data.map((row, i) => ({
      sheetRow: i + 2,
      firstName: row[0], lastName: row[1], comp: row[2], reg: row[3],
      status: (row[REPLACEMENT_STATUS_COL - 1] || "").toString().trim() || "Active"
    })).filter(r => r.firstName || r.lastName);
    return { status: "Success", rows: rows };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/** Appends a replacement-pool member. */
function portal_addReplacement(rep) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('ReplacementPool');
    if (!sheet) return { status: "Error", message: "No ReplacementPool sheet found." };
    if (!rep || !(rep.firstName || "").toString().trim()) return { status: "Error", message: "First name is required." };
    if (sheet.getMaxColumns() < REPLACEMENT_STATUS_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), REPLACEMENT_STATUS_COL - sheet.getMaxColumns());
    }
    const row = [rep.firstName || "", rep.lastName || "", rep.comp || "", rep.reg || "", "Active"];
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    return { status: "Success", sheetRow: sheet.getLastRow() };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/** Updates one replacement-pool member, addressed by sheetRow. */
function portal_updateReplacement(rep) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('ReplacementPool');
    if (!sheet) return { status: "Error", message: "No ReplacementPool sheet found." };
    const r = parseInt(rep && rep.sheetRow, 10);
    if (!r || r < 2 || r > sheet.getLastRow()) return { status: "Error", message: "That row no longer exists — reload the directory." };
    if (sheet.getMaxColumns() < REPLACEMENT_STATUS_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), REPLACEMENT_STATUS_COL - sheet.getMaxColumns());
    }
    const existing = sheet.getRange(r, 1, 1, REPLACEMENT_STATUS_COL).getValues()[0];
    const row = [
      rep.firstName !== undefined ? rep.firstName : existing[0],
      rep.lastName !== undefined ? rep.lastName : existing[1],
      rep.comp !== undefined ? rep.comp : existing[2],
      rep.reg !== undefined ? rep.reg : existing[3],
      rep.status !== undefined ? rep.status : (existing[4] || "Active")
    ];
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    return { status: "Success" };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Soft-deletes a replacement-pool member (Status = Inactive) rather than
 * removing the row — replacement names are recorded in the Replacements history
 * sheet, and row numbers are the dashboard's handle for every other entry.
 */
function portal_deleteReplacement(req) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('ReplacementPool');
    if (!sheet) return { status: "Error", message: "No ReplacementPool sheet found." };
    const r = parseInt(req && req.sheetRow, 10);
    if (!r || r < 2 || r > sheet.getLastRow()) return { status: "Error", message: "That row no longer exists — reload the directory." };
    if (sheet.getMaxColumns() < REPLACEMENT_STATUS_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), REPLACEMENT_STATUS_COL - sheet.getMaxColumns());
    }
    sheet.getRange(r, REPLACEMENT_STATUS_COL).setValue(req.reactivate ? "Active" : "Inactive");
    return { status: "Success" };
  } catch (e) { return { status: "Error", message: e.toString() }; }
}

/**
 * Looks up recipient email(s) for a company from the "CompanyEmails" sheet.
 * Sheet layout expected: Column A = Company name, Column B = Emails
 * (comma-separated if more than one recipient for that company).
 * Falls back to a default address if the sheet or a matching row isn't found.
 */
function getRecipientsForCompany(company) {
  const FALLBACK_EMAIL = "sbalist45@gmail.com";
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CompanyEmails');
  if (!sheet) return FALLBACK_EMAIL;

  const data = sheet.getDataRange().getValues();
  const target = company.toString().toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    const rowComp = data[i][0].toString().toLowerCase().trim();
    if (rowComp === target) {
      const emails = data[i][1] ? data[i][1].toString().trim() : "";
      return emails || FALLBACK_EMAIL;
    }
  }
  return FALLBACK_EMAIL;
}

/** Converts an HTML string into a downloadable PDF blob for email attachment */
function htmlToPdfBlob(html, filenameBase) {
  const wrapped = `<html><body style="font-family: Arial, sans-serif;">${html}</body></html>`;
  const htmlBlob = Utilities.newBlob(wrapped, 'text/html', filenameBase + '.html');
  return htmlBlob.getAs('application/pdf').setName(filenameBase + '.pdf');
}
