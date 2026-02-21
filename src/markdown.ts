export interface FrontmatterSplitResult {
	frontmatter: string | null;
	body: string;
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function splitFrontmatter(markdown: string): FrontmatterSplitResult {
	const raw = markdown ?? "";
	const lines = raw.split(/\r?\n/);
	if (lines.length === 0 || lines[0].trim() !== "---") {
		return { frontmatter: null, body: raw };
	}

	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			endIndex = i;
			break;
		}
	}

	if (endIndex === -1) {
		// Malformed frontmatter; treat everything as body.
		return { frontmatter: null, body: raw };
	}

	const frontmatter = lines.slice(1, endIndex).join("\n");
	const body = lines.slice(endIndex + 1).join("\n").trim();
	return { frontmatter, body };
}

export function extractFrontmatterScalar(
	frontmatter: string | null,
	key: string
): string | null {
	if (!frontmatter) {
		return null;
	}

	// Shallow parse: supports "key: value" on a single line.
	const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "mi");
	const match = frontmatter.match(pattern);
	if (!match) {
		return null;
	}
	const value = stripQuotes(match[1] ?? "");
	return value ? value : null;
}

function parseInlineList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inside = trimmed.slice(1, -1);
		return inside
			.split(",")
			.map((item) => stripQuotes(item))
			.map((item) => item.trim())
			.filter((item) => item);
	}

	// Support "tag1, tag2" or "tag1 tag2"
	return trimmed
		.split(/[,\s]+/)
		.map((item) => stripQuotes(item))
		.map((item) => item.trim())
		.filter((item) => item);
}

export function extractFrontmatterTags(frontmatter: string | null): string[] {
	if (!frontmatter) {
		return [];
	}

	const lines = frontmatter.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^\s*tags\s*:\s*(.*)$/i);
		if (!match) {
			continue;
		}
		const rest = (match[1] ?? "").trim();
		if (rest) {
			return parseInlineList(rest);
		}

		// YAML list:
		// tags:
		//   - a
		//   - b
		const tags: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const candidate = lines[j];
			if (!candidate.trim()) {
				continue;
			}
			if (/^\s*-\s+/.test(candidate)) {
				tags.push(stripQuotes(candidate.replace(/^\s*-\s+/, "")));
				continue;
			}
			// Stop when a new top-level key begins.
			if (/^\s*\w[\w-]*\s*:/.test(candidate) && !/^\s+/.test(candidate)) {
				break;
			}
			// Unknown indentation/structure; stop to avoid over-capturing.
			break;
		}
		return tags.map((tag) => tag.trim()).filter((tag) => tag);
	}

	return [];
}

function stripFencedCodeBlocks(markdown: string): string {
	let without = markdown;
	without = without.replace(/```[\s\S]*?```/g, " ");
	without = without.replace(/~~~[\s\S]*?~~~/g, " ");
	return without;
}

function stripInlineCode(markdown: string): string {
	return markdown.replace(/`[^`]*`/g, " ");
}

export function extractHashtagsFromMarkdown(markdown: string): string[] {
	const raw = markdown ?? "";
	const withoutCode = stripInlineCode(stripFencedCodeBlocks(raw));
	const tags: string[] = [];
	const regex = /(?:^|[\s\n])#([^\s#[\]]+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(withoutCode)) !== null) {
		const value = (match[1] ?? "").trim();
		if (!value) {
			continue;
		}
		tags.push(value);
	}
	return tags;
}

function normalizeTag(tag: string): string | null {
	const trimmed = tag.trim().replace(/^#/, "");
	if (!trimmed) {
		return null;
	}

	// Drop trailing punctuation that often follows a tag in prose.
	const cleaned = trimmed.replace(/[),.;:!?，。；：！？]+$/g, "").trim();
	if (!cleaned) {
		return null;
	}
	if (cleaned.length <= 1) {
		return null;
	}
	if (/^\d+$/.test(cleaned)) {
		return null;
	}
	return cleaned;
}

export function extractAllTagsFromMarkdown(markdown: string): string[] {
	const split = splitFrontmatter(markdown);
	const frontmatterTags = extractFrontmatterTags(split.frontmatter);
	const bodyTags = extractHashtagsFromMarkdown(split.body);

	const set = new Set<string>();
	[...frontmatterTags, ...bodyTags].forEach((raw) => {
		const normalized = normalizeTag(raw);
		if (normalized) {
			set.add(normalized);
		}
	});

	return Array.from(set);
}
