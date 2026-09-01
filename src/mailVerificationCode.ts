export const extractMailVerificationCode = (
  value: string
): string | undefined => {
  const text = value.replace(/[\u200B-\u200D\uFEFF]/g, ' ');
  const contextual = text.match(
    /(?:(?:verification|one[ -]?time)(?:[ -]?(?:code|password|passcode|pin|number))?|otp(?:[ -]?(?:code|password))?|(?:security|confirmation|login|sign[ -]?in)[ -]?(?:code|pin|number)|passcode|验证码|校验码|确认码|动态码|安全码)(?:\s+is)?[^0-9]{0,12}([0-9]{4,8})(?!\d)/i
  );
  if (contextual?.[1]) return contextual[1];

  // Six digits is the overwhelmingly common mail OTP shape. Keep this fallback strict so
  // order numbers, dates and tracking identifiers are not promoted as verification codes.
  const standalone = text.match(/(?:^|\D)(\d{6})(?!\d)/);
  return standalone?.[1];
};
