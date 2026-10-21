/**
 * Decode messages arriving on Kahoot's cometd (/meta/*, /service/*) channels.
 */

/**
 * Server -> client `/service/player` data ids.
 * @type {Record<number,string>}
 */
export const PLAYER_EVENTS = {
  1: "questionReady",
  2: "questionStart",
  3: "quizEnd",
  4: "timeOver",
  5: "gameReset",
  7: "answerResponse",
  8: "questionEnd",
  9: "quizStart",
  10: "disconnect",
  12: "feedbackAck",
  13: "podium",
  14: "nameAccept",
  17: "authLogin",
  19: "teamAccept",
  20: "teamTalk",
  41: "brainstormStart",
  51: "twoFactorWrong",
  52: "twoFactorCorrect",
  53: "twoFactorReset",
};

/**
 * @typedef {Object} DecodedEvent
 * @property {string} name    event name (or "service" for unknown ids)
 * @property {number|null} id raw data id
 * @property {object} content parsed `data.content` JSON ({} when absent)
 * @property {object} raw     the raw cometd message
 */

/**
 * Try to turn a raw cometd message into a named event.
 * @param {object} msg
 * @returns {DecodedEvent|null} null for meta/heartbeat messages
 */
export function decodeEvent(msg) {
  if (!msg || typeof msg !== "object") return null;
  const channel = msg.channel || "";
  const data = msg.data || {};

  if (channel === "/service/controller") {
    if (data.type === "loginResponse") {
      return { name: "loginResponse", id: null, content: { ...data }, raw: msg };
    }
    if (data.type === "message" && data.id != null) {
      return {
        name: `controller:${data.id}`,
        id: Number(data.id),
        content: parseContent(data.content),
        raw: msg,
      };
    }
    return null;
  }

  if (channel === "/service/status") {
    return { name: "status", id: null, content: { ...data }, raw: msg };
  }

  if (channel === "/service/player") {
    if (data.id == null) return null;
    const id = Number(data.id);
    return {
      name: PLAYER_EVENTS[id] || `player:${id}`,
      id,
      content: parseContent(data.content),
      raw: msg,
    };
  }

  return null;
}

/**
 * @param {unknown} content
 * @returns {object}
 */
export function parseContent(content) {
  if (content == null || content === "") return {};
  if (typeof content === "object") return content;
  try {
    const parsed = JSON.parse(String(content));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
