declare var AppleAllInOnePasswordGenerator: {
  generateCompatiblePassword(
    requirements?: {
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      requireLower?: boolean;
      requireUpper?: boolean;
      requireDigit?: boolean;
      requireSymbol?: boolean;
      forbidSymbols?: boolean;
      allowedSymbols?: string;
    },
    options?: {
      allowSymbols?: boolean;
      length?: number;
      allowedSymbols?: string;
    }
  ): {
    password: string;
    compatible: boolean;
    reason?: string;
    adapted?: boolean;
  };
};
