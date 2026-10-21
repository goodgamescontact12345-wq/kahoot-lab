/**
 * Outgoing Kahoot packet builders (client -> server, `/service/controller`).
 * Shapes follow the official web client as documented by kahoot.js / Pyhoot.
 */

/**
 * Login / join packet.
 * @param {{gameid:string, name:string, userAgent:string}} p
 * @returns {object}
 */
export function loginPacket({ gameid, name, userAgent }) {
  return {
    channel: "/service/controller",
    data: {
      gameid: String(gameid),
      host: "kahoot.it",
      name,
      type: "login",
      content: JSON.stringify({
        device: {
          userAgent,
          screen: { width: 1920, height: 1080 },
        },
      }),
    },
  };
}

/**
 * Namerator / join-verify packet (id 16). Kahoot only lists players in the
 * host lobby after this follow-up is sent.
 * @param {{gameid:string, usingNamerator?:boolean, stableIdentifier?:string, avatar?:object}} p
 * @returns {object}
 */
export function joinVerifyPacket({ gameid, usingNamerator = false, stableIdentifier = null, avatar = null }) {
  const content = { usingNamerator };
  if (stableIdentifier) content.stableIdentifier = stableIdentifier;
  if (avatar) content.avatar = avatar;
  return {
    channel: "/service/controller",
    data: {
      gameid: String(gameid),
      host: "kahoot.it",
      type: "message",
      id: 16,
      content: JSON.stringify(content),
    },
  };
}

/**
 * Question answer packet (id 45).
 * @param {{
 *   gameid:string,
 *   questionIndex:number,
 *   type:string,
 *   choice?:number|number[],
 *   text?:string,
 *   lag?:number,
 *   pin?:{x:number,y:number}
 * }} p
 * @returns {object}
 */
export function answerPacket({ gameid, questionIndex, type, choice, text, lag = 30, pin = null }) {
  const payload = {
    questionIndex,
    meta: { lag },
    type,
  };
  if (pin) payload.pin = pin;
  else if (text != null) payload.text = text;
  else payload.choice = choice;
  return {
    channel: "/service/controller",
    data: {
      gameid: String(gameid),
      host: "kahoot.it",
      id: 45,
      type: "message",
      content: JSON.stringify(payload),
    },
  };
}

/**
 * Two-factor auth answer packet (id 50).
 * @param {{gameid:string, sequence:number[]}} p
 * @returns {object}
 */
export function twoFactorPacket({ gameid, sequence }) {
  return {
    channel: "/service/controller",
    data: {
      gameid: String(gameid),
      host: "kahoot.it",
      id: 50,
      type: "message",
      content: JSON.stringify({ sequence }),
    },
  };
}

/**
 * Disconnect packet (`/meta/disconnect`).
 * @returns {object}
 */
export function leavePacket() {
  return {
    channel: "/meta/disconnect",
    ext: { timesync: Date.now() },
  };
}
