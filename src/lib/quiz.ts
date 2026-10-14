import type { Config, ContentPack, Language, Question, Session } from "../types.js";
import { t } from "./i18n.js";

export type QuizConfig = Config;
export type QuizSession = Session;

export const MAX_REFRESHES = 2;
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_GROUP_TITLE_LIMIT = 128;
const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

export const DEFAULT_CONFIG: Config = {
  language: "cn",
  enabled: false,
  contentId: "default",
  timeoutSeconds: 300,
  cooldownSeconds: 1800,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isId(value: unknown): value is string {
  return isBoundedText(value, 64);
}

function isOptions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const options: unknown[] = value;
  return (
    options.every((option) => isBoundedText(option, 100)) &&
    new Set(options.map((option) => (option as string).trim())).size === options.length
  );
}

function validateLocalizedQuestion(
  value: unknown,
  questionIndex: number,
  language: Language,
): string | null {
  if (!isRecord(value)) {
    return `questions[${questionIndex}].translations.${language} must be an object.`;
  }
  if (!isBoundedText(value.prompt, 2000)) {
    return `questions[${questionIndex}].translations.${language}.prompt must be a non-empty string of at most 2000 characters.`;
  }
  if (!isOptions(value.options)) {
    return `questions[${questionIndex}].translations.${language}.options must contain four unique non-empty choices of at most 100 characters.`;
  }
  if (
    value.explanation !== undefined &&
    (typeof value.explanation !== "string" || value.explanation.length > 2000)
  ) {
    return `questions[${questionIndex}].translations.${language}.explanation must be a string of at most 2000 characters.`;
  }
  return null;
}

function localizedQuestion(
  question: Question,
  language: Language,
): {
  prompt: string;
  options: string[];
} {
  const translation = question.translations?.[language];
  return {
    prompt: translation?.prompt ?? question.prompt,
    options: translation?.options ?? question.options,
  };
}

function formatChoices(options: readonly string[], language: Language): string {
  return options
    .map((option, index) => t(language, "choice", { letter: OPTION_LETTERS[index], option }))
    .join("\n");
}

function questionMessageText({
  language,
  title,
  current,
  total,
  prompt,
  choices,
  rules,
  rulesVersion,
  deadline,
}: {
  language: Language;
  title: string;
  current: number;
  total: number;
  prompt: string;
  choices: string;
  rules: string;
  rulesVersion: string;
  deadline: string;
}): string {
  return t(language, "question", {
    title,
    current,
    total,
    prompt,
    choices,
    rules,
    version: rulesVersion,
    deadline,
  });
}

function validateQuestion(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `questions[${index}] must be an object.`;
  if (!isId(value.id))
    return `questions[${index}].id must be a non-empty string of at most 64 characters.`;
  if (!isBoundedText(value.prompt, 2000)) {
    return `questions[${index}].prompt must be a non-empty string of at most 2000 characters.`;
  }
  if (!isOptions(value.options)) {
    return `questions[${index}].options must contain four unique non-empty choices of at most 100 characters.`;
  }
  if (
    typeof value.answerIndex !== "number" ||
    !Number.isSafeInteger(value.answerIndex) ||
    value.answerIndex < 0 ||
    value.answerIndex >= value.options.length
  ) {
    return `questions[${index}].answerIndex must identify one of its four choices.`;
  }
  if (
    value.explanation !== undefined &&
    (typeof value.explanation !== "string" || value.explanation.length > 2000)
  ) {
    return `questions[${index}].explanation must be a string of at most 2000 characters.`;
  }

  if (!isRecord(value.translations)) {
    return `questions[${index}].translations must include an English translation.`;
  }
  if (!isRecord(value.translations.en)) {
    return `questions[${index}].translations must include an English translation.`;
  }
  const englishError = validateLocalizedQuestion(value.translations.en, index, "en");
  if (englishError) return englishError;
  if (value.translations.cn !== undefined) {
    const chineseError = validateLocalizedQuestion(value.translations.cn, index, "cn");
    if (chineseError) return chineseError;
  }
  return null;
}

/** Validate a group-specific quiz configuration. */
export function validateConfig(config: unknown): string | null {
  if (!isRecord(config)) return "Config must be an object.";
  if (config.language !== "en" && config.language !== "cn") return "language must be en or cn.";
  if (typeof config.enabled !== "boolean") return "enabled must be a boolean.";
  if (!isId(config.contentId))
    return "contentId must be a non-empty string of at most 64 characters.";
  if (
    typeof config.timeoutSeconds !== "number" ||
    !Number.isSafeInteger(config.timeoutSeconds) ||
    config.timeoutSeconds < 1 ||
    config.timeoutSeconds > 86400
  ) {
    return "timeoutSeconds must be an integer between 1 and 86400.";
  }
  if (
    typeof config.cooldownSeconds !== "number" ||
    !Number.isSafeInteger(config.cooldownSeconds) ||
    config.cooldownSeconds < 0 ||
    config.cooldownSeconds > 604800
  ) {
    return "cooldownSeconds must be an integer between 0 and 604800.";
  }
  if (config.deleteJoinMessages !== undefined && typeof config.deleteJoinMessages !== "boolean")
    return "deleteJoinMessages must be a boolean.";
  return null;
}

/** Validate a private, bilingual question pack before it can back a session. */
export function validateContentPack(pack: unknown): string | null {
  if (!isRecord(pack)) return "Content pack must be an object.";
  if (!isId(pack.id)) return "id must be a non-empty string of at most 64 characters.";
  if (!isId(pack.version)) return "version must be a non-empty string of at most 64 characters.";
  if (!Array.isArray(pack.questions) || pack.questions.length < 3 || pack.questions.length > 100) {
    return "questions must contain between 3 and 100 entries.";
  }

  const ids = new Set<string>();
  for (let index = 0; index < pack.questions.length; index += 1) {
    const question = pack.questions[index];
    const error = validateQuestion(question, index);
    if (error) return error;
    const questionId = (question as Question).id;
    if (ids.has(questionId)) return `questions[${index}].id must be unique.`;
    ids.add(questionId);
  }

  if (!isRecord(pack.rules)) return "rules must be an object.";
  if (!isId(pack.rules.version))
    return "rules.version must be a non-empty string of at most 64 characters.";
  for (const language of ["cn", "en"] as const) {
    if (!isBoundedText(pack.rules[language], 3000)) {
      return `rules.${language} must be a non-empty string of at most 3000 characters.`;
    }
  }

  const deadlinePlaceholder = "9999-12-31T23:59:59.999Z";
  for (let index = 0; index < pack.questions.length; index += 1) {
    const question = pack.questions[index] as Question;
    for (const language of ["cn", "en"] as const) {
      const localized = localizedQuestion(question, language);
      const rendered = questionMessageText({
        language,
        title: "T".repeat(TELEGRAM_GROUP_TITLE_LIMIT),
        current: 3,
        total: 3,
        prompt: localized.prompt,
        choices: formatChoices(localized.options, language),
        rules: pack.rules[language] as string,
        rulesVersion: pack.rules.version as string,
        deadline: deadlinePlaceholder,
      });
      if (rendered.length > TELEGRAM_TEXT_LIMIT) {
        return `questions[${index}] plus the complete rules and choices exceed Telegram's ${TELEGRAM_TEXT_LIMIT}-character message limit in ${language}.`;
      }
    }
  }
  return null;
}

function randomIndex(random: () => number, maxInclusive: number): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample <= 0) return 0;
  if (sample >= 1) return maxInclusive;
  return Math.floor(sample * (maxInclusive + 1));
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const otherIndex = randomIndex(random, index);
    [values[index], values[otherIndex]] = [values[otherIndex], values[index]];
  }
  return values;
}

/** Select distinct question snapshots and randomize each answer's displayed position. */
export function selectQuestions(
  questions: readonly Question[],
  count = 3,
  random: () => number = Math.random,
  language: Language = "cn",
): Question[] {
  if (!Array.isArray(questions)) throw new TypeError("questions must be an array.");
  if (!Number.isSafeInteger(count) || count < 1 || count > questions.length) {
    throw new RangeError("count must be an integer between 1 and the number of questions.");
  }
  const selected = shuffle([...questions], random).slice(0, count);
  return selected.map((question) => {
    const translation = question.translations?.[language];
    const options: string[] = translation?.options ?? question.options;
    const choices: { text: string; isAnswer: boolean }[] = options.map(
      (text: string, index: number) => ({
        text,
        isAnswer: index === question.answerIndex,
      }),
    );
    shuffle(choices, random);
    const snapshot: Question = {
      id: question.id,
      prompt: translation?.prompt ?? question.prompt,
      options: choices.map(({ text }) => text),
      answerIndex: choices.findIndex(({ isAnswer }) => isAnswer),
    };
    const explanation = translation?.explanation ?? question.explanation;
    if (explanation !== undefined) snapshot.explanation = explanation;
    return snapshot;
  });
}

export interface CreateSessionInput {
  key: string;
  groupId: number;
  userId: number;
  userChatId: number;
  requestDate: number;
  requestId: string;
  title: string;
  nonce: string;
  config?: Config;
  content: ContentPack;
  now?: number;
  random?: () => number;
}

export function createSession(input: CreateSessionInput): Session {
  const config = input.config ?? DEFAULT_CONFIG;
  const configError = validateConfig(config);
  if (configError) throw new TypeError(configError);
  const contentError = validateContentPack(input.content);
  if (contentError) throw new TypeError(contentError);
  if (input.content.id !== config.contentId) {
    throw new TypeError("content.id must match config.contentId.");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) throw new TypeError("now must be a finite timestamp in milliseconds.");
  if (typeof input.nonce !== "string" || !/^[A-Za-z0-9]{1,24}$/.test(input.nonce)) {
    throw new TypeError("nonce must contain 1 to 24 ASCII letters or digits.");
  }

  const language = config.language;
  const expiresAt = now + config.timeoutSeconds * 1000;
  if (!Number.isFinite(expiresAt) || Number.isNaN(new Date(expiresAt).getTime())) {
    throw new TypeError("session deadline must be a valid timestamp.");
  }
  return {
    key: input.key,
    groupId: input.groupId,
    userId: input.userId,
    userChatId: input.userChatId,
    requestDate: input.requestDate,
    requestId: input.requestId,
    title: input.title,
    nonce: input.nonce,
    language,
    status: "active",
    questions: selectQuestions(input.content.questions, 3, input.random ?? Math.random, language),
    index: 0,
    formatVersion: 3,
    contentVersion: input.content.version,
    refreshes: 0,
    rules: { version: input.content.rules.version, text: input.content.rules[language] },
    expiresAt,
    cooldownSeconds: config.cooldownSeconds,
    blockedUntil: 0,
    revision: 0,
    messageId: null,
  };
}

function copySession(session: Session): Session {
  return {
    ...session,
    questions: session.questions.map((question) => ({
      ...question,
      options: question.options.slice(),
    })),
    rules: { ...session.rules },
  };
}

function decline(session: Session, now: number): { kind: "decision"; session: Session } {
  session.status = "decline_pending";
  session.blockedUntil = now + session.cooldownSeconds * 1000;
  return { kind: "decision", session };
}

function ignored(session: Session, reason: string): AnswerIgnored {
  return { kind: "ignored", session, reason };
}

export interface SessionActionInput {
  userId: number;
  nonce: string;
  index: unknown;
  now?: number;
}

export interface AnswerInput extends SessionActionInput {
  option: unknown;
}

export type AnswerIgnored = { kind: "ignored"; session: Session; reason: string };
export type AnswerResult =
  | AnswerIgnored
  | { kind: "question"; session: Session }
  | { kind: "decision"; session: Session };

function actionError(session: Session, action: SessionActionInput): string | null {
  if (action.userId !== session.userId) return "wrong_user";
  if (action.nonce !== session.nonce) return "wrong_nonce";
  if (!Number.isSafeInteger(action.index) || action.index !== session.index) return "stale_index";
  return null;
}

function actionTime(action: SessionActionInput): number | null {
  const now = action.now ?? Date.now();
  return Number.isFinite(now) ? now : null;
}

/** Apply one untrusted multiple-choice callback to an active session. */
export function answerSession(session: Session, answer: AnswerInput): AnswerResult {
  if (session.status !== "active") return ignored(session, "not_active");
  const actionProblem = actionError(session, answer);
  if (actionProblem) return ignored(session, actionProblem);
  const question = session.questions[session.index];
  if (
    !question ||
    typeof answer.option !== "number" ||
    !Number.isSafeInteger(answer.option) ||
    answer.option < 0 ||
    answer.option >= question.options.length
  ) {
    return ignored(session, "invalid_option");
  }
  const now = actionTime(answer);
  if (now === null) return ignored(session, "invalid_time");

  const updated = copySession(session);
  if (now >= session.expiresAt) return decline(updated, now);
  updated.rulesAcceptedAt = now;
  updated.rulesAcceptedVersion = session.rules.version;
  if (answer.option !== question.answerIndex) return decline(updated, now);

  updated.status = "approve_pending";
  return { kind: "decision", session: updated };
}

/** Skip the current question while leaving the original deadline and snapshot intact. */
export function refreshSession(session: Session, action: SessionActionInput): AnswerResult {
  if (session.status !== "active") return ignored(session, "not_active");
  const actionProblem = actionError(session, action);
  if (actionProblem) return ignored(session, actionProblem);
  const now = actionTime(action);
  if (now === null) return ignored(session, "invalid_time");
  const updated = copySession(session);
  if (now >= session.expiresAt) return decline(updated, now);
  if (session.refreshes >= MAX_REFRESHES) return ignored(session, "refresh_limit");
  if (session.index >= session.questions.length - 1) {
    return ignored(session, "no_next_question");
  }
  updated.index += 1;
  updated.refreshes += 1;
  return { kind: "question", session: updated };
}

function isCallbackSession(value: Pick<Session, "nonce" | "index">): boolean {
  return (
    /^[A-Za-z0-9]{1,24}$/.test(value.nonce) && Number.isSafeInteger(value.index) && value.index >= 0
  );
}

export function callbackData(
  session: Pick<Session, "nonce" | "index">,
  option: number,
): string | null {
  if (!isCallbackSession(session) || !Number.isSafeInteger(option) || option < 0 || option > 3)
    return null;
  const data = `q:${session.nonce}:${session.index}:${option}`;
  return data.length <= 64 ? data : null;
}

export function refreshCallbackData(session: Pick<Session, "nonce" | "index">): string | null {
  if (!isCallbackSession(session)) return null;
  const data = `f:${session.nonce}:${session.index}`;
  return data.length <= 64 ? data : null;
}

export type ParsedCallbackData =
  | { kind: "answer"; nonce: string; index: number; option: number }
  | { kind: "refresh"; nonce: string; index: number };

export function parseCallbackData(data: unknown): ParsedCallbackData | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const match = /^([qf]):([A-Za-z0-9]{1,24}):(0|[1-9]\d*)(?::(0|[1-9]\d*))?$/.exec(data);
  if (!match) return null;
  const kindCode = match[1];
  const index = Number(match[3]);
  if (!Number.isSafeInteger(index)) return null;
  if (kindCode === "f") {
    if (match[4] !== undefined) return null;
    return { kind: "refresh", nonce: match[2], index };
  }
  const value = Number(match[4]);
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) return null;
  return { kind: "answer", nonce: match[2], index, option: value };
}

function callbackMarkup(rows: { text: string; callback_data: string }[][]) {
  return { inline_keyboard: rows };
}

/** Render the current question and, when possible, a bounded skip action. */
export function renderQuestion(session: Session): {
  text: string;
  reply_markup: ReturnType<typeof callbackMarkup>;
} {
  if (session.status !== "active") throw new TypeError("session must be active.");
  const question = session.questions[session.index];
  if (!question) throw new RangeError("session has no current question.");
  const text = questionMessageText({
    language: session.language,
    title: session.title,
    current: session.index + 1,
    total: session.questions.length,
    prompt: question.prompt,
    choices: formatChoices(question.options, session.language),
    rules: session.rules.text,
    rulesVersion: session.rules.version,
    deadline: new Date(session.expiresAt).toISOString(),
  });
  if (text.length > TELEGRAM_TEXT_LIMIT) {
    throw new RangeError(
      `Rendered question exceeds Telegram's ${TELEGRAM_TEXT_LIMIT}-character message limit.`,
    );
  }
  const rows = question.options.map((_, index) => {
    const data = callbackData(session, index);
    if (!data) throw new RangeError("Question callback data exceeds Telegram limits.");
    return [
      {
        text: t(session.language, "answerButton", { letter: OPTION_LETTERS[index] }),
        callback_data: data,
      },
    ];
  });
  if (session.refreshes < MAX_REFRESHES && session.index < session.questions.length - 1) {
    const data = refreshCallbackData(session);
    if (!data) throw new RangeError("Refresh callback data exceeds Telegram limits.");
    rows.push([
      {
        text: t(session.language, "refreshButton", {
          remaining: MAX_REFRESHES - session.refreshes,
        }),
        callback_data: data,
      },
    ]);
  }
  return { text, reply_markup: callbackMarkup(rows) };
}
