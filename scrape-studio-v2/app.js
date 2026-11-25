let scrapedData = [];
const IGNORED_EMAILS = new Set(["hgzly@zju.edu.cn", "xwmaster@zju.edu.cn"]);

const dropZone = document.getElementById("dropZone");
const urlInput = document.getElementById("targetUrl");

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const droppedText = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
  if (droppedText.trim().startsWith("http")) {
    urlInput.value = droppedText.trim();
    startScraping();
  }
});

function fillUrl(link) {
  urlInput.value = link;
}

function showStatus(msg, type = "info") {
  const el = document.getElementById("statusMsg");
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove("hidden");
}

async function fetchHtml(targetUrl) {
  const encoded = encodeURIComponent(targetUrl);
  const proxies = [
    async () => {
      const res = await fetch(`https://api.allorigins.win/get?url=${encoded}`);
      if (!res.ok) throw new Error("AllOrigins error");
      const data = await res.json();
      return data.contents || "";
    },
    async () => {
      const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encoded}`);
      if (!res.ok) throw new Error("CodeTabs error");
      return await res.text();
    },
    async () => {
      const res = await fetch(`https://corsproxy.io/?${encoded}`);
      if (!res.ok) throw new Error("CorsProxy error");
      return await res.text();
    },
  ];

  for (const fetcher of proxies) {
    try {
      const html = await fetcher();
      if (html && html.length > 50) return html;
    } catch (_) {}
  }
  throw new Error("Failed to fetch target URL. The site may be unreachable or blocking proxy requests.");
}

function extractEmails(text) {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const valid = [];
  for (const m of matches) {
    const low = m.toLowerCase();
    if (!IGNORED_EMAILS.has(low) && !low.match(/\.(png|jpg|jpeg|gif|svg|webp)$/)) {
      if (!valid.includes(m)) valid.push(m);
    }
  }
  return valid;
}

async function parseFacultyProfile(profileUrl, name) {
  let targetUrl = profileUrl;
  if (targetUrl.includes("person.zju.edu.cn") && !targetUrl.includes("/en/")) {
    const slug = targetUrl.replace(/\/$/, "").split("/").pop();
    targetUrl = `https://person.zju.edu.cn/en/${slug}`;
  }

  let html = "";
  try {
    html = await fetchHtml(targetUrl);
  } catch (_) {}

  if ((!html || !extractEmails(html).length) && profileUrl.includes("zju.edu.cn")) {
    const slug = name.replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (slug) {
      try {
        html = await fetchHtml(`https://person.zju.edu.cn/en/${slug}`);
      } catch (_) {}
    }
  }

  if (!html) return { email: "", research: "" };

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const fullText = doc.body ? doc.body.innerText : "";
  const emails = extractEmails(fullText);
  const email = emails[0] || "";

  const lines = fullText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let researchLines = [];
  let capture = false;
  const stopWords = [
    "biography",
    "education",
    "publications",
    "teaching",
    "projects",
    "awards",
    "patents",
    "work experience",
    "copyright",
    "scan me",
  ];

  for (const line of lines) {
    const low = line.toLowerCase();
    if (/^research\s*(interests?|areas?|fields?|directions?)?\s*:?/i.test(low)) {
      capture = true;
      const after = line.includes(":") ? line.split(":").slice(1).join(":").trim() : "";
      if (after && after.length > 2) researchLines.push(after);
      continue;
    }
    if (capture) {
      if (stopWords.some((w) => low.startsWith(w))) break;
      const cleaned = line.replace(/^[·•\-*]+\s*/, "").trim();
      if (cleaned.length > 2) researchLines.push(cleaned);
      if (researchLines.join(", ").length > 400) break;
    }
  }

  return {
    email,
    research: researchLines.join(", "),
  };
}

async function startScraping() {
  const startUrl = urlInput.value.trim();
  if (!startUrl) {
    showStatus("Please enter a valid website URL.", "error");
    return;
  }

  const mode = document.getElementById("scrapeMode").value;
  const maxPages = Math.min(Number(document.getElementById("maxPages").value) || 1, 5);
  const followProfiles = document.getElementById("followProfiles").checked;

  const btn = document.getElementById("scrapeBtn");
  const btnText = document.getElementById("btnText");
  const btnLoader = document.getElementById("btnLoader");

  btn.disabled = true;
  btnText.textContent = "Scraping...";
  btnLoader.classList.remove("hidden");
  showStatus("Fetching and parsing pages, please wait...", "info");

  try {
    const visited = new Set();
    let currentUrl = startUrl;
    let results = [];
    const globalSeenNames = new Set();

    for (let p = 0; p < maxPages && currentUrl && !visited.has(currentUrl); p++) {
      visited.add(currentUrl);
      showStatus(`Scraping page ${p + 1} of ${maxPages}: ${currentUrl}`, "info");

      const html = await fetchHtml(currentUrl);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      if (mode === "faculty") {
        const candidates = [];

        doc.querySelectorAll("a[href]").forEach((el) => {
          const href = el.getAttribute("href") || "";
          let name = (el.textContent || "").replace(/\s+/g, " ").trim();
          name = name.replace(/^\d{4}\s*\d{2}-\d{2}\s*/, "").trim();

          if (!name || name.length < 3 || name.length > 60) return;
          if (/^(home|next|prev|last|first|chinese|office|faculty|more|jumpto|back to top)/i.test(name)) return;
          if (/list\.htm|main\.htm|javascript:|#/i.test(href)) return;

          const isProfLink =
            href.includes("person.") ||
            /\/\d{4}\/\d{4}\/c\d+a\d+\/page\.htm/.test(href) ||
            /faculty|staff|people|teacher|prof/i.test(href);

          if (!isProfLink || globalSeenNames.has(name.toLowerCase())) return;
          globalSeenNames.add(name.toLowerCase());

          let absUrl = href;
          try {
            absUrl = new URL(href, currentUrl).href;
          } catch (_) {}

          const parentEl = el.closest("li, tr, div");
          const parentText = parentEl ? parentEl.textContent || "" : "";
          let institute = "";
          let title = "";

          parentText.split("\n").forEach((l) => {
            const t = l.trim();
            if (/institute|center|department|school/i.test(t) && t.length < 100 && t !== name) {
              institute = t;
            }
            if (/^(Full Professor|Associate Professor|Assistant Professor|Professor|ZJU-100 Talent|Postdoc)$/i.test(t)) {
              title = t;
            }
          });

          candidates.push({ name, title, institute, profileUrl: absUrl });
        });

        if (followProfiles && candidates.length > 0) {
          showStatus(`Found ${candidates.length} faculty members on page ${p + 1}. Extracting emails & research interests...`, "info");
          const batchSize = 6;
          for (let i = 0; i < candidates.length; i += batchSize) {
            const batch = candidates.slice(i, i + batchSize);
            const enriched = await Promise.all(
              batch.map(async (item) => {
                const details = await parseFacultyProfile(item.profileUrl, item.name);
                return {
                  Name: item.name,
                  Title: item.title || "Faculty",
                  Institute: item.institute || new URL(currentUrl).hostname,
                  Email: details.email,
                  Research_Interests: details.research,
                  Profile_URL: item.profileUrl,
                };
              })
            );
            results.push(...enriched);
          }
        } else {
          results.push(
            ...candidates.map((c) => ({
              Name: c.name,
              Title: c.title || "Faculty",
              Institute: c.institute || new URL(currentUrl).hostname,
              Email: "",
              Research_Interests: "",
              Profile_URL: c.profileUrl,
            }))
          );
        }
      } else if (mode === "emails") {
        const emails = extractEmails(doc.body ? doc.body.innerText : html);
        emails.forEach((em) => results.push({ Email: em, Source_URL: currentUrl }));
      } else if (mode === "links") {
        doc.querySelectorAll("a[href]").forEach((el) => {
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          const href = el.getAttribute("href");
          if (href && !href.startsWith("javascript:")) {
            try {
              const abs = new URL(href, currentUrl).href;
              results.push({ Link_Text: text || "[No Text]", URL: abs });
            } catch (_) {}
          }
        });
      } else if (mode === "tables") {
        doc.querySelectorAll("table tr").forEach((tr) => {
          const rowObj = {};
          tr.querySelectorAll("th, td").forEach((cell, cIdx) => {
            rowObj[`Column_${cIdx + 1}`] = (cell.textContent || "").replace(/\s+/g, " ").trim();
          });
          if (Object.keys(rowObj).length > 0) results.push(rowObj);
        });
      } else if (mode === "headings") {
        doc.querySelectorAll("h1, h2, h3, h4, p").forEach((el) => {
          const tag = el.tagName.toUpperCase();
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length > 15) {
            results.push({ Tag: tag, Content: text });
          }
        });
      } else if (mode === "images") {
        doc.querySelectorAll("img[src]").forEach((el) => {
          const alt = el.getAttribute("alt") || "";
          const src = el.getAttribute("src");
          if (src) {
            try {
              const abs = new URL(src, currentUrl).href;
              results.push({ Alt_Text: alt, Image_URL: abs });
            } catch (_) {}
          }
        });
      }

      let nextHref = null;
      doc.querySelectorAll("a[href]").forEach((el) => {
        const txt = (el.textContent || "").trim().toLowerCase();
        const h = el.getAttribute("href");
        if (h && !h.includes("javascript") && (txt.includes("nextpage") || txt === "next")) {
          try {
            nextHref = new URL(h, currentUrl).href;
          } catch (_) {}
        }
      });
      currentUrl = nextHref;
    }

    scrapedData = results;
    if (scrapedData.length === 0) {
      showStatus("No matching records found on this page. Try a different extraction target.", "error");
      document.getElementById("resultSection").classList.add("hidden");
    } else {
      showStatus(`Successfully extracted ${scrapedData.length} records.`, "info");
      renderTable(scrapedData);
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btnText.textContent = "Scrape Now";
    btnLoader.classList.add("hidden");
  }
}

function renderTable(data) {
  const section = document.getElementById("resultSection");
  const thead = document.getElementById("tableHead");
  const tbody = document.getElementById("tableBody");
  document.getElementById("recordCount").textContent = data.length;

  thead.innerHTML = "";
  tbody.innerHTML = "";

  if (data.length === 0) return;

  const headers = Object.keys(data[0]);
  const headRow = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  data.forEach((row) => {
    const tr = document.createElement("tr");
    headers.forEach((h) => {
      const td = document.createElement("td");
      const val = row[h] || "";
      if (typeof val === "string" && val.startsWith("http")) {
        td.innerHTML = `<a href="${val}" target="_blank" style="color:#60a5fa;">Open Link ↗</a>`;
      } else {
        td.textContent = val;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  section.classList.remove("hidden");
}

function filterTable() {
  const q = document.getElementById("searchFilter").value.toLowerCase();
  const filtered = scrapedData.filter((row) =>
    Object.values(row).some((val) => String(val).toLowerCase().includes(q))
  );
  renderTable(filtered);
}

function triggerDownload(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportCSV() {
  if (!scrapedData.length) return;
  const headers = Object.keys(scrapedData[0]);
  const csvRows = [
    headers.join(","),
    ...scrapedData.map((row) =>
      headers.map((h) => `"${String(row[h] || "").replace(/"/g, '""')}"`).join(",")
    ),
  ];
  const blob = new Blob(["\uFEFF" + csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, "scraped_data.csv");
}

function exportExcel() {
  if (!scrapedData.length) return;
  const ws = XLSX.utils.json_to_sheet(scrapedData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "ScrapedData");
  XLSX.writeFile(wb, "scraped_data.xlsx");
}

function exportPDF() {
  if (!scrapedData.length) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape" });
  const headers = Object.keys(scrapedData[0]);
  const body = scrapedData.map((row) => headers.map((h) => String(row[h] || "")));

  doc.text("Scraped Web Data Report", 14, 15);
  doc.autoTable({
    head: [headers],
    body: body,
    startY: 20,
    styles: { fontSize: 8, cellWidth: "wrap" },
  });
  doc.save("scraped_data.pdf");
}

function exportWord() {
  if (!scrapedData.length) return;
  const headers = Object.keys(scrapedData[0]);
  let html = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
    <head><meta charset='utf-8'><title>Scraped Data</title></head>
    <body>
      <h2>Scraped Website Data</h2>
      <table border='1' style='border-collapse:collapse; width:100%; font-family:Times New Roman, serif;'>
        <thead><tr>${headers.map((h) => `<th style='background:#eee; padding:6px;'>${h}</th>`).join("")}</tr></thead>
        <tbody>
          ${scrapedData
            .map(
              (row) =>
                `<tr>${headers.map((h) => `<td style='padding:6px;'>${row[h] || ""}</td>`).join("")}</tr>`
            )
            .join("")}
        </tbody>
      </table>
    </body></html>`;
  const blob = new Blob(["\uFEFF" + html], { type: "application/msword" });
  triggerDownload(blob, "scraped_data.doc");
}

function exportMarkdown() {
  if (!scrapedData.length) return;
  const headers = Object.keys(scrapedData[0]);
  const headerLine = `| ${headers.join(" | ")} |`;
  const dividerLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rows = scrapedData.map(
    (row) => `| ${headers.map((h) => String(row[h] || "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`
  );
  const mdContent = `# Scraped Data\n\n${headerLine}\n${dividerLine}\n${rows.join("\n")}`;
  const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8;" });
  triggerDownload(blob, "scraped_data.md");
}

function exportJSON() {
  if (!scrapedData.length) return;
  const blob = new Blob([JSON.stringify(scrapedData, null, 2)], { type: "application/json" });
  triggerDownload(blob, "scraped_data.json");
}
