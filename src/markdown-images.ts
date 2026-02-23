export interface StripImageUrlQueryParamsResult {
	content: string;
	strippedCount: number;
}

function decodeHtmlEntities(text: string): string {
	// Decode named entities first so that double-encoded sequences like
	// &amp;#61; become &#61; before the numeric pass decodes them.
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(parseInt(code, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function stripUrlQueryParamsPreservingFragment(url: string): string {
	const raw = url ?? "";

	// Decode HTML entities so that encoded ?, #, &, = are correctly recognized.
	// Source content may have &amp; for &, &#61; for =, &#63; for ?, etc.
	const decoded = decodeHtmlEntities(raw.trim());

	if (!decoded.includes("?")) {
		return raw;
	}

	// Preserve any surrounding whitespace inside the link destination.
	const leadingWhitespace = raw.match(/^\s*/)?.[0] ?? "";
	const trailingWhitespace = raw.match(/\s*$/)?.[0] ?? "";

	const queryIndex = decoded.indexOf("?");
	if (queryIndex === -1) {
		return raw;
	}

	const hashIndex = decoded.indexOf("#");
	let stripped: string;
	if (hashIndex !== -1 && hashIndex > queryIndex) {
		// Keep fragment: "a?b#c" -> "a#c"
		stripped = `${decoded.slice(0, queryIndex)}${decoded.slice(hashIndex)}`;
	} else {
		// Either no fragment or the "?" appears after "#". Remove everything after the first "?".
		stripped = decoded.slice(0, queryIndex);
	}

	return `${leadingWhitespace}${stripped}${trailingWhitespace}`;
}

function rewriteHtmlImgSrcAttributes(text: string): StripImageUrlQueryParamsResult {
	const raw = text ?? "";
	let strippedCount = 0;

	// Replace only the src attribute value for <img ...> tags.
	// Supports: src="...", src='...', src=unquoted
	const rewritten = raw.replace(
		/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
		(
			match,
			dquoted: string | undefined,
			squoted: string | undefined,
			bare: string | undefined
		) => {
			const url = dquoted ?? squoted ?? bare ?? "";
			const stripped = stripUrlQueryParamsPreservingFragment(url);
			if (stripped === url) {
				return match;
			}
			strippedCount++;

			// Reconstruct just the matched src=... prefix; we intentionally do not touch
			// the rest of the tag to avoid accidental replacements in other attributes.
			if (dquoted !== undefined) {
				const escaped = stripped.replace(/"/g, "%22");
				return match.replace(
					/(\bsrc\s*=\s*)"(?:[^"]*)"/i,
					(_m: string, prefix: string) => `${prefix}"${escaped}"`
				);
			}
			if (squoted !== undefined) {
				const escaped = stripped.replace(/'/g, "%27");
				return match.replace(
					/(\bsrc\s*=\s*)'(?:[^']*)'/i,
					(_m: string, prefix: string) => `${prefix}'${escaped}'`
				);
			}
			return match.replace(
				/(\bsrc\s*=\s*)([^\s>]+)$/i,
				(_m: string, prefix: string) => `${prefix}${stripped}`
			);
		}
	);

	return { content: rewritten, strippedCount };
}

function rewriteMarkdownImageDestinations(
	text: string
): StripImageUrlQueryParamsResult {
	const raw = text ?? "";
	let strippedCount = 0;
	let out = "";

	let index = 0;
	while (index < raw.length) {
		const bangIndex = raw.indexOf("![", index);
		if (bangIndex === -1) {
			out += raw.slice(index);
			break;
		}

		out += raw.slice(index, bangIndex);

		// Parse alt text: ![alt]
		let cursor = bangIndex + 2; // position after "!["
		let altClosed = false;
		while (cursor < raw.length) {
			const ch = raw[cursor];
			if (ch === "\\") {
				cursor += 2;
				continue;
			}
			if (ch === "]") {
				altClosed = true;
				break;
			}
			cursor++;
		}

		if (!altClosed) {
			// No closing bracket; treat as plain text.
			out += raw.slice(bangIndex);
			break;
		}

		const afterAlt = cursor + 1;
		let afterWs = afterAlt;
		while (afterWs < raw.length && /\s/.test(raw[afterWs])) {
			afterWs++;
		}

		if (raw[afterWs] !== "(") {
			// Reference-style image or something else; leave untouched.
			out += raw.slice(bangIndex, afterWs);
			index = afterWs;
			continue;
		}

		const openParen = afterWs;
		let pos = openParen + 1;
		while (pos < raw.length && /\s/.test(raw[pos])) {
			pos++;
		}

		let destStart = pos;
		let destEnd = pos;
		let isAngle = false;

		if (raw[pos] === "<") {
			isAngle = true;
			destStart = pos + 1;
			const close = raw.indexOf(">", destStart);
			if (close === -1) {
				// Malformed; fall back to copying verbatim.
				out += raw.slice(bangIndex, openParen + 1);
				index = openParen + 1;
				continue;
			}
			destEnd = close;
			pos = close + 1;
		} else {
			let depth = 0;
			while (pos < raw.length) {
				const ch = raw[pos];
				if (ch === "\\") {
					pos += 2;
					continue;
				}
				if (ch === "(") {
					depth++;
					pos++;
					continue;
				}
				if (ch === ")") {
					if (depth === 0) {
						destEnd = pos;
						break;
					}
					depth--;
					pos++;
					continue;
				}
				if (/\s/.test(ch) && depth === 0) {
					destEnd = pos;
					break;
				}
				pos++;
			}
			destEnd = destEnd === destStart ? pos : destEnd;
		}

		const destRaw = raw.slice(destStart, destEnd);
		const destStripped = stripUrlQueryParamsPreservingFragment(destRaw);
		if (destStripped !== destRaw) {
			strippedCount++;
		}

		// Now find the end of the full "(...)" group.
		let closeParen = -1;
		let outerDepth = 1;
		let quote: "\"" | "'" | null = null;
		let scan = isAngle ? pos : destEnd;
		while (scan < raw.length) {
			const ch = raw[scan];
			if (ch === "\\") {
				scan += 2;
				continue;
			}
			if (quote) {
				if (ch === quote) {
					quote = null;
				}
				scan++;
				continue;
			}
			if (ch === "\"" || ch === "'") {
				quote = ch;
				scan++;
				continue;
			}
			if (ch === "(") {
				outerDepth++;
				scan++;
				continue;
			}
			if (ch === ")") {
				outerDepth--;
				if (outerDepth === 0) {
					closeParen = scan;
					break;
				}
				scan++;
				continue;
			}
			scan++;
		}

		if (closeParen === -1) {
			// Malformed; copy the rest as-is.
			out += raw.slice(bangIndex);
			break;
		}

		// Reconstruct the full image syntax, only changing the destination.
		if (destStripped === destRaw) {
			out += raw.slice(bangIndex, closeParen + 1);
		} else {
			out += raw.slice(bangIndex, destStart);
			out += destStripped;
			out += raw.slice(destEnd, closeParen + 1);
		}

		index = closeParen + 1;
	}

	return { content: out, strippedCount };
}

function rewriteOutsideInlineCode(
	text: string,
	rewrite: (segment: string) => StripImageUrlQueryParamsResult
): StripImageUrlQueryParamsResult {
	const raw = text ?? "";
	let strippedCount = 0;
	let out = "";

	let index = 0;
	while (index < raw.length) {
		const tickIndex = raw.indexOf("`", index);
		if (tickIndex === -1) {
			const rewritten = rewrite(raw.slice(index));
			out += rewritten.content;
			strippedCount += rewritten.strippedCount;
			break;
		}

		const before = rewrite(raw.slice(index, tickIndex));
		out += before.content;
		strippedCount += before.strippedCount;

		let runLen = 0;
		while (raw[tickIndex + runLen] === "`") {
			runLen++;
		}

		const fence = "`".repeat(runLen);
		const closeIndex = raw.indexOf(fence, tickIndex + runLen);
		if (closeIndex === -1) {
			// No closing delimiter; treat the rest as plain text.
			const tail = rewrite(raw.slice(tickIndex));
			out += tail.content;
			strippedCount += tail.strippedCount;
			break;
		}

		// Copy inline code span verbatim.
		out += raw.slice(tickIndex, closeIndex + runLen);
		index = closeIndex + runLen;
	}

	return { content: out, strippedCount };
}

function rewriteOutsideFencedCodeBlocks(
	markdown: string,
	rewrite: (segment: string) => StripImageUrlQueryParamsResult
): StripImageUrlQueryParamsResult {
	const raw = markdown ?? "";
	let strippedCount = 0;

	let out = "";
	let buffer = "";

	let inFence = false;
	let fenceChar: "`" | "~" | null = null;
	let fenceLen = 0;

	const flushBuffer = () => {
		if (!buffer) {
			return;
		}
		const rewritten = rewriteOutsideInlineCode(buffer, rewrite);
		out += rewritten.content;
		strippedCount += rewritten.strippedCount;
		buffer = "";
	};

	let index = 0;
	while (index < raw.length) {
		const nextNewline = raw.indexOf("\n", index);
		const lineEnd = nextNewline === -1 ? raw.length : nextNewline + 1;
		const line = raw.slice(index, lineEnd);

		const fenceMatch = line.match(/^\s*([`~]{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			const char = marker[0] as "`" | "~";
			const len = marker.length;

			if (!inFence) {
				flushBuffer();
				inFence = true;
				fenceChar = char;
				fenceLen = len;
				out += line;
				index = lineEnd;
				continue;
			}

			// End fence must match the opening marker type and length (or longer).
			if (char === fenceChar && len >= fenceLen) {
				inFence = false;
				fenceChar = null;
				fenceLen = 0;
				out += line;
				index = lineEnd;
				continue;
			}
		}

		if (inFence) {
			out += line;
		} else {
			buffer += line;
		}
		index = lineEnd;
	}

	flushBuffer();
	return { content: out, strippedCount };
}

export function stripQueryParamsFromImageUrls(
	markdown: string
): StripImageUrlQueryParamsResult {
	const raw = markdown ?? "";

	// Two-pass rewrite for the plain-text segments:
	// 1) HTML <img src=...>
	// 2) Markdown images ![](...)
	const rewriteSegment = (segment: string): StripImageUrlQueryParamsResult => {
		const html = rewriteHtmlImgSrcAttributes(segment);
		const md = rewriteMarkdownImageDestinations(html.content);
		return {
			content: md.content,
			strippedCount: html.strippedCount + md.strippedCount,
		};
	};

	// Skip fenced blocks and inline code spans to avoid rewriting example URLs.
	return rewriteOutsideFencedCodeBlocks(raw, rewriteSegment);
}

