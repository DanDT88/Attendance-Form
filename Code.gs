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
  const regions = [...new Set(data.slice(1).map(row => row[3]))].filter(r => r !== "").sort();
  const allStaff = data.slice(1).map(row => ({ name: row[0] + " " + row[1], region: row[3] }));
  return { regions: regions, allStaff: allStaff };
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
  const toMins = (t) => {
    const bits = t.split(':').map(Number);
    if (bits.length < 2 || isNaN(bits[0]) || isNaN(bits[1])) return null;
    return bits[0] * 60 + bits[1];
  };
  const startMins = toMins(parts[0]);
  let endMins = toMins(parts[1]);
  let leftMins = toMins(timeLeft);
  if (startMins === null || endMins === null || leftMins === null) return null;
  const isOvernightShift = endMins <= startMins;
  if (isOvernightShift) {
    if (endMins <= startMins) endMins += 1440;
    if (leftMins < startMins) leftMins += 1440;
  }
  const diff = endMins - leftMins;
  return diff > 0 ? diff : 0;
}

/** portal_commitAttendanceRow */
function portal_commitAttendanceRow(payload, isLateEntry = false, skipEmail = false, isEarlyEntry = false) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let attSheet = ss.getSheetByName('Attendance') || ss.insertSheet('Attendance');
    let repSheet = ss.getSheetByName('Replacements') || ss.insertSheet('Replacements');

    if (attSheet.getLastRow() === 0) attSheet.appendRow(["Timestamp", "Date", "Shift", "Company", "Region", "Site", "Employee", "Status", "Reason/Duration", "Replacement", "Supervisor", "Sign-off Name", "SupPhoto", "StaffPhotoCount", "SubmissionID", "Shift Type", "End Shift Time", "End Shift SubmissionID", "End Shift SupPhoto", "End Shift StaffPhoto"]);
    if (repSheet.getLastRow() === 0) repSheet.appendRow(["Timestamp", "Date", "Region", "Site", "Absent Staff", "Replacement Name", "Reason", "Supervisor"]);

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
        attRows.push([ts, payload.date, payload.shift, payload.comp, payload.reg, payload.site, r.name, r.status, detail, r.replacement || "N/A", payload.loggedUser, payload.signOffName, sheetSupPhoto, payload.staffPhotoCount, payload.submissionId || "", payload.shiftType || ""]);
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

    // The Attendance header row is only written when the sheet is brand new, so a
    // sheet created before end-of-shift photos existed won't have these two columns.
    // Widen the sheet if necessary and label them on first use.
    if (attSheet.getMaxColumns() < END_STAFF_PHOTO_COL) {
      attSheet.insertColumnsAfter(attSheet.getMaxColumns(), END_STAFF_PHOTO_COL - attSheet.getMaxColumns());
    }
    if (!attSheet.getRange(1, END_SUP_PHOTO_COL).getValue()) attSheet.getRange(1, END_SUP_PHOTO_COL).setValue("End Shift SupPhoto");
    if (!attSheet.getRange(1, END_STAFF_PHOTO_COL).getValue()) attSheet.getRange(1, END_STAFF_PHOTO_COL).setValue("End Shift StaffPhoto");

    const numCols = Math.max(attSheet.getLastColumn(), END_STAFF_PHOTO_COL);
    const data = attSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    const tz = ss.getSpreadsheetTimeZone();
    // Sheets auto-converts a "yyyy-MM-dd" string into a real Date value on write, so when we
    // read it back it's a Date object, not the original string — normalize both sides the same
    // way before comparing, or every match silently fails.
    const normalizeDate = (v) => {
      if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd");
      return (v || "").toString().trim();
    };
    const deepClean = (v) => (v || "").toString().toLowerCase().trim();
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
