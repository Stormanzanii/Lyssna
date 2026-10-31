/** A Jam invite from Spotify or Lyssna: short `spotify.link`, the long
 * `open.spotify.com/socialsession` link, or its `spotify:` URI. */
export const isJamLink = (text: string) =>
  /^(?:(?:https?:\/\/)?spotify\.link\/[A-Za-z0-9]+|(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?socialsession\/[A-Za-z0-9_-]+|spotify:socialsession:[A-Za-z0-9_-]+)(?:[?#]\S*)?$/.test(
    text.trim(),
  );
