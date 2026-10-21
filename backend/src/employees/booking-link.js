'use strict';

const { hmacHex, sha256Hex } = require('../lib/crypto');
const { formatIstDate, formatIstDateTime } = require('../lib/time');

// The one shared booking link (PRD C1, open question 1: "shared link per booking").
//
// The token is derived from LINK_SECRET, the booking id and the booking's link version, so
// the coordinator can copy it again at any time while the database stores only its
// SHA-256 (for lookup). It is unguessable without the secret. Raising
// share_token_version replaces the link.
//
// The token sits in the URL fragment (#/b/<token>), which browsers never send to the
// server, and the page passes it to the API in a request header, so it never appears in
// nginx or application logs.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function bookingLinkToken(config, booking) {
  const hex = hmacHex(config.linkSecret, `booking-link:${booking.id}:${booking.shareTokenVersion ?? 1}`);
  return Buffer.from(hex, 'hex').toString('base64url');
}

const tokenHash = (token) => sha256Hex(`booking-link:${token}`);

function bookingLinkUrl(config, token) {
  return `${config.appOrigin}/#/b/${token}`;
}

/** Display values shared by the page and the messages. */
function bookingFacts(booking) {
  const city = booking.hotelCity && booking.hotelCity !== booking.location ? booking.hotelCity : null;
  return {
    event: booking.eventName,
    hotel: booking.hotelDisplayName ?? booking.hotelName,
    city,
    location: booking.location,
    checkIn: booking.checkInDate ? formatIstDate(booking.checkInDate) : null,
    checkOut: booking.checkOutDate ? formatIstDate(booking.checkOutDate) : null,
  };
}

/** The deadline as people read it, or a placeholder when hospitality has not set it yet. */
const deadlineText = (deadlineAt) => (deadlineAt ? formatIstDateTime(deadlineAt) : '(deadline to be confirmed by hospitality)');

/**
 * Ready-to-copy invitation texts (PRD "Messages and tracking", invitation template).
 * The WhatsApp version is for a group; the email version is the same text with a
 * subject, sent by the coordinator until system-sent emails arrive.
 */
function invitationMessages(booking, url) {
  const f = bookingFacts(booking);
  const where = [f.hotel, f.city].filter(Boolean).join(', ');
  const lines = [
    `Aadhaar upload for ${f.event} at ${where} (${f.checkIn} to ${f.checkOut}), ${f.location}.`,
    `Open ${url}, pick your name, verify with the OTP sent to your email and upload by ${deadlineText(booking.deadlineAt)}.`,
    'PVC card: front and back. Old vertical card: front only. Photo or PDF.',
    'Your copy is used only for hotel check-in and is deleted after the trip.',
  ];
  return {
    whatsapp: [`Hi team, ${lines[0]}`, ...lines.slice(1)].join('\n'),
    email: {
      subject: `Aadhaar upload for ${f.event} at ${f.hotel}: please upload by ${booking.deadlineAt ? formatIstDate(booking.deadlineAt) : 'the deadline'}`,
      body: ['Hi all,', '', ...lines, '', 'Thank you.'].join('\n'),
    },
  };
}

module.exports = { bookingLinkToken, tokenHash, bookingLinkUrl, bookingFacts, invitationMessages, deadlineText, TOKEN_PATTERN };
