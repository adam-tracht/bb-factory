import { ProtocolError } from "../protocol/errors.js";
import { PROTOCOL_PATHS } from "../protocol/paths.js";

interface SectionSpan {
  readonly heading: string;
  readonly headingLine: number;
  readonly endLine: number;
}

function headingSectionsOutsideFences(content: string): SectionSpan[] {
  const lines = content.split("\n");
  const sections: SectionSpan[] = [];
  let fence: string | undefined;
  let current: { heading: string; headingLine: number } | undefined;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      if (!fence) {
        fence = fenceMatch[1];
      } else if (fence[0] === fenceMatch[1][0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (fence) return;

    const headingMatch = line.match(/^##\s+(.+?)\s*$/u);
    if (headingMatch) {
      if (current) sections.push({ ...current, endLine: index });
      current = { heading: headingMatch[1], headingLine: index };
    }
  });
  if (current) sections.push({ ...current, endLine: lines.length });
  return sections;
}

function findSectionById(content: string, id: string): SectionSpan | null {
  const matches = headingSectionsOutsideFences(content).filter(
    (section) => section.heading === id || section.heading.startsWith(`${id} `),
  );
  return matches.length === 1 ? matches[0] : null;
}

function collapseToFieldValue(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function setSectionField(lines: string[], span: SectionSpan, field: string, value: string): string[] {
  const fieldLine = `${field}: ${collapseToFieldValue(value)}`;
  const pattern = new RegExp(`^${field}\\s*:`);
  const body: string[] = [];
  let replaced = false;
  for (let index = span.headingLine + 1; index < span.endLine; index += 1) {
    const line = lines[index];
    if (!replaced && pattern.test(line)) {
      body.push(fieldLine);
      replaced = true;
    } else {
      body.push(line);
    }
  }
  if (!replaced) {
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    body.push(fieldLine);
  }
  return [...lines.slice(0, span.headingLine + 1), ...body, ...lines.slice(span.endLine)];
}

export class ActionTargetMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionTargetMissingError";
  }
}

/** Replace or append `answer:` inside the `## <questionId>` section of questions.md. */
export function writeQuestionAnswer(content: string, questionId: string, answer: string): string {
  const span = findSectionById(content, questionId);
  if (!span) {
    throw new ActionTargetMissingError(`Question '${questionId}' is not present in the protocol file.`);
  }
  return setSectionField(content.split("\n"), span, "answer", answer).join("\n");
}

/** Set `status: ready` and `approved:` inside the `## <queueItemId>` section of queue.md. */
export function writeQueueApproval(content: string, queueItemId: string, approvedText: string): string {
  const span = findSectionById(content, queueItemId);
  if (!span) {
    throw new ActionTargetMissingError(`Queue item '${queueItemId}' is not present in the protocol file.`);
  }
  const lines = content.split("\n");
  const withStatus = setSectionField(lines, span, "status", "ready").join("\n");
  const adjusted = findSectionById(withStatus, queueItemId);
  if (!adjusted) {
    throw new ProtocolError("malformed-protocol", `Queue item '${queueItemId}' could not be re-located after its status write`, {
      path: PROTOCOL_PATHS.queue,
      rule: "queue-target",
      hint: "restore the queue item heading before retrying the action",
    });
  }
  return setSectionField(withStatus.split("\n"), adjusted, "approved", approvedText).join("\n");
}
