const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MEDIA_EXTENSIONS = {
	video: [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"],
	audio: [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"],
	office: [".doc", ".docx", ".xls", ".xlsx", ".xslx"],
};

function normalizeInputUrl(input) {
	const trimmed = String(input || "").trim();
	if (!trimmed) {
		return "";
	}

	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}

	return `https://${trimmed}`;
}

function toAbsoluteUrl(rawUrl, baseUrl) {
	if (!rawUrl) {
		return "";
	}

	const cleaned = String(rawUrl)
		.trim()
		.replace(/^['\"]+|['\"]+$/g, "")
		.replace(/\\u0026/gi, "&")
		.replace(/&amp;/gi, "&")
		.replace(/\\\//g, "/")
		.replace(/\\+$/g, "");
	if (!cleaned || cleaned.startsWith("#")) {
		return "";
	}

	if (/^(data|javascript|mailto|tel):/i.test(cleaned)) {
		return "";
	}

	try {
		return new URL(cleaned, baseUrl).toString();
	} catch {
		return "";
	}
}

function filenameFromUrl(url) {
	try {
		const parsed = new URL(url);
		const fromQuery = parsed.searchParams.get("file") || parsed.searchParams.get("filename");
		if (fromQuery) {
			const queryName = fromQuery.split("/").filter(Boolean).pop();
			if (queryName) {
				return decodeURIComponent(queryName);
			}
		}

		const pathname = parsed.pathname;
		const last = pathname.split("/").filter(Boolean).pop();
		return decodeURIComponent(last || "file");
	} catch {
		return "file";
	}
}

function extensionBelongsTo(url, type) {
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		return MEDIA_EXTENSIONS[type].some((ext) => pathname.endsWith(ext));
	} catch {
		return false;
	}
}

function isPdfLink(value) {
	const lower = String(value || "").toLowerCase();
	return lower.includes(".pdf") || lower.includes("application/pdf");
}

function isOfficeLink(value) {
	const lower = String(value || "").toLowerCase();
	return (
		MEDIA_EXTENSIONS.office.some((extension) => lower.includes(extension)) ||
		lower.includes("application/vnd.openxmlformats-officedocument") ||
		lower.includes("application/msword") ||
		lower.includes("application/vnd.ms-excel")
	);
}

function extractDocumentUrlsFromText(text, baseUrl) {
	const results = {
		pdf: new Set(),
		office: new Set(),
	};

	const absoluteUrlRegex = /https?:\/\/[^\s"'<>\\]+/gi;
	const relativeDocRegex = /(?:^|["'\s])(\/[^\s"'<>]+?\.(?:pdf|docx?|xlsx?|xslx)(?:\?[^\s"'<>]*)?)(?=$|["'\s])/gi;

	for (const match of String(text || "").match(absoluteUrlRegex) || []) {
		const absolute = toAbsoluteUrl(match, baseUrl);
		if (!absolute) {
			continue;
		}

		if (isPdfLink(absolute)) {
			results.pdf.add(absolute);
		}

		if (isOfficeLink(absolute)) {
			results.office.add(absolute);
		}
	}

	for (const match of String(text || "").matchAll(relativeDocRegex)) {
		const absolute = toAbsoluteUrl(match[1], baseUrl);
		if (!absolute) {
			continue;
		}

		if (isPdfLink(absolute)) {
			results.pdf.add(absolute);
		}

		if (isOfficeLink(absolute)) {
			results.office.add(absolute);
		}
	}

	return {
		pdf: Array.from(results.pdf),
		office: Array.from(results.office),
	};
}

function decodeRepeated(value, maxTimes = 3) {
	let output = String(value || "");
	for (let index = 0; index < maxTimes; index += 1) {
		try {
			const decoded = decodeURIComponent(output);
			if (decoded === output) {
				break;
			}
			output = decoded;
		} catch {
			break;
		}
	}
	return output;
}

function buildDownloadCandidates(mediaUrl) {
	const candidates = [mediaUrl];

	try {
		const parsed = new URL(mediaUrl);
		const fileParam = parsed.searchParams.get("file") || parsed.searchParams.get("url");

		if (!fileParam) {
			return candidates;
		}

		const decodedPath = decodeRepeated(fileParam);
		if (!decodedPath || (!isPdfLink(decodedPath) && !isOfficeLink(decodedPath))) {
			return candidates;
		}

		const directFileUrl = new URL(decodedPath, `${parsed.protocol}//${parsed.host}`).toString();
		if (!candidates.includes(directFileUrl)) {
			candidates.unshift(directFileUrl);
		}
	} catch {
		return candidates;
	}

	return candidates;
}

async function collectPdfFromNetwork(pageUrl) {
	let browser;
	const docUrls = {
		pdf: new Set(),
		office: new Set(),
	};

	try {
		try {
			browser = await chromium.launch({ headless: true, channel: "msedge" });
		} catch {
			browser = await chromium.launch({ headless: true });
		}

		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
		});
		const page = await context.newPage();

		page.on("request", (request) => {
			const requestUrl = request.url();
			if (isPdfLink(requestUrl)) {
				docUrls.pdf.add(requestUrl);
			}

			if (isOfficeLink(requestUrl)) {
				docUrls.office.add(requestUrl);
			}
		});

		page.on("response", (response) => {
			const responseUrl = response.url();
			const contentType = response.headers()["content-type"] || "";

			if (isPdfLink(responseUrl) || isPdfLink(contentType)) {
				docUrls.pdf.add(responseUrl);
			}

			if (isOfficeLink(responseUrl) || isOfficeLink(contentType)) {
				docUrls.office.add(responseUrl);
			}
		});

		await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForTimeout(4000);

		await context.close();
		return {
			pdf: Array.from(docUrls.pdf),
			office: Array.from(docUrls.office),
		};
	} catch {
		return {
			pdf: [],
			office: [],
		};
	} finally {
		if (browser) {
			await browser.close();
		}
	}
}

async function downloadWithBrowser(mediaUrl, referer) {
	let browser;

	try {
		try {
			browser = await chromium.launch({ headless: true, channel: "msedge" });
		} catch {
			browser = await chromium.launch({ headless: true });
		}

		const context = await browser.newContext({
			acceptDownloads: false,
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
		});

		const page = await context.newPage();

		if (referer) {
			await page.goto(referer, { waitUntil: "domcontentloaded", timeout: 30000 });
			await page.waitForTimeout(1200);
		}

		const origin = referer ? new URL(referer).origin : undefined;
		const apiResponse = await context.request.get(mediaUrl, {
			timeout: 30000,
			failOnStatusCode: false,
			headers: {
				Accept: "application/pdf,application/octet-stream,*/*",
				"Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
				Referer: referer || undefined,
				Origin: origin,
			},
		});

		if (apiResponse.ok()) {
			const contentType = apiResponse.headers()["content-type"] || "application/octet-stream";
			const bodyBuffer = await apiResponse.body();
			await context.close();
			return {
				contentType,
				buffer: bodyBuffer,
			};
		}

		await context.close();
		return null;
	} catch {
		return null;
	} finally {
		if (browser) {
			await browser.close();
		}
	}
}

app.post("/api/crawl", async (req, res) => {
	const { url } = req.body || {};
	const pageUrl = normalizeInputUrl(url);

	if (!pageUrl) {
		return res.status(400).json({ error: "URL không hợp lệ." });
	}

	try {
		const response = await axios.get(pageUrl, {
			timeout: 20000,
			responseType: "text",
			maxRedirects: 5,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
			},
		});

		const finalUrl = response.request?.res?.responseUrl || pageUrl;
		const $ = cheerio.load(response.data);
		const buckets = {
			image: new Map(),
			video: new Map(),
			audio: new Map(),
			pdf: new Map(),
			office: new Map(),
		};

		const addItem = (type, value) => {
			const absolute = toAbsoluteUrl(value, finalUrl);
			if (!absolute || buckets[type].has(absolute)) {
				return;
			}

			buckets[type].set(absolute, {
				url: absolute,
				filename: filenameFromUrl(absolute),
			});
		};

		const readFirstAttr = ($el, attrs) => {
			for (const attr of attrs) {
				const value = $el.attr(attr);
				if (value) {
					return value;
				}
			}
			return "";
		};

		$("img[src], img[data-src], img[data-original], img[data-lazy-src]").each((_, el) => {
			addItem("image", readFirstAttr($(el), ["src", "data-src", "data-original", "data-lazy-src"]));
		});
		$("source[srcset]").each((_, el) => {
			const srcset = $(el).attr("srcset") || "";
			const firstSrc = srcset.split(",")[0]?.trim().split(" ")[0];
			addItem("image", firstSrc);
		});
		$("meta[property='og:image'][content], meta[name='twitter:image'][content]").each((_, el) =>
			addItem("image", $(el).attr("content"))
		);

		$("video[src], video[data-src], video source[src], video source[data-src]").each((_, el) => {
			addItem("video", readFirstAttr($(el), ["src", "data-src"]));
		});
		$("audio[src], audio[data-src], audio source[src], audio source[data-src]").each((_, el) => {
			addItem("audio", readFirstAttr($(el), ["src", "data-src"]));
		});

		$("a[href], a[data-href], source[src], source[data-src], video[src], video[data-src], audio[src], audio[data-src]").each((_, el) => {
			const href = readFirstAttr($(el), ["href", "src", "data-src", "data-href", "data-url", "data-file"]);
			const absolute = toAbsoluteUrl(href, finalUrl);
			if (!absolute) {
				return;
			}

			if (extensionBelongsTo(absolute, "video")) {
				addItem("video", absolute);
			}

			if (extensionBelongsTo(absolute, "audio")) {
				addItem("audio", absolute);
			}

			if (extensionBelongsTo(absolute, "office")) {
				addItem("office", absolute);
			}
		});

		$(
			"a[href], a[data-href], a[data-url], a[data-file], embed[src], embed[data-src], iframe[src], iframe[data-src], object[data], source[src], source[data-src]"
		).each((_, el) => {
			const candidate = readFirstAttr($(el), ["href", "src", "data", "data-src", "data-href", "data-url", "data-file"]);
			const absolute = toAbsoluteUrl(candidate, finalUrl);
			if (!absolute) {
				return;
			}

			if (absolute.toLowerCase().includes(".pdf")) {
				addItem("pdf", absolute);
			}

			if (extensionBelongsTo(absolute, "office")) {
				addItem("office", absolute);
			}
		});

		const networkDocs = await collectPdfFromNetwork(finalUrl);
		networkDocs.pdf.forEach((pdfUrl) => addItem("pdf", pdfUrl));
		networkDocs.office.forEach((officeUrl) => addItem("office", officeUrl));

		const textDocs = extractDocumentUrlsFromText(response.data, finalUrl);
		textDocs.pdf.forEach((pdfUrl) => addItem("pdf", pdfUrl));
		textDocs.office.forEach((officeUrl) => addItem("office", officeUrl));

		return res.json({
			sourceUrl: finalUrl,
			image: Array.from(buckets.image.values()),
			video: Array.from(buckets.video.values()),
			audio: Array.from(buckets.audio.values()),
			pdf: Array.from(buckets.pdf.values()),
			office: Array.from(buckets.office.values()),
		});
	} catch (error) {
		return res.status(500).json({
			error: "Không thể cào dữ liệu từ URL này.",
			details: error.message,
		});
	}
});

app.get("/api/download", async (req, res) => {
	const mediaUrl = normalizeInputUrl(req.query.url);
	const referer = normalizeInputUrl(req.query.referer);

	if (!mediaUrl) {
		return res.status(400).json({ error: "Thiếu URL file cần tải." });
	}

	try {
		const origin = referer ? new URL(referer).origin : undefined;
		const baseHeaders = {
			"User-Agent": "Mozilla/5.0",
			Accept:
				"application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.ms-excel,application/octet-stream,*/*",
			"Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
			Origin: origin || undefined,
		};

		if (referer) {
			baseHeaders.Referer = referer;
		}
		const candidateUrls = buildDownloadCandidates(mediaUrl);
		let lastError;

		for (const candidateUrl of candidateUrls) {
			try {
				const response = await axios.get(candidateUrl, {
					responseType: "stream",
					timeout: 30000,
					maxRedirects: 5,
					headers: baseHeaders,
				});

				const fileName = filenameFromUrl(candidateUrl);
				const contentType = response.headers["content-type"] || "application/octet-stream";

				res.setHeader("Content-Type", contentType);
				res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

				response.data.pipe(res);
				return;
			} catch (innerError) {
				lastError = innerError;
			}
		}

		throw lastError || new Error("Không thể tải file từ các URL ứng viên");
	} catch (error) {
		if (error.response?.status === 401 || error.response?.status === 403) {
			const browserDownload = await downloadWithBrowser(mediaUrl, referer);
			if (browserDownload?.buffer?.length) {
				const fileName = filenameFromUrl(mediaUrl);
				res.setHeader("Content-Type", browserDownload.contentType);
				res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
				return res.end(browserDownload.buffer);
			}
		}

		return res.status(500).json({
			error: "Không tải được file từ nguồn.",
			details: error.message,
		});
	}
});

app.use((req, res) => {
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
	console.log(`Server chạy tại http://localhost:${PORT}`);
});
