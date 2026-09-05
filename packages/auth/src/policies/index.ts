export function jurisdiction(input: {
  remoteIp: string;
  countryHeader?: string | undefined;
  trustedProxyIps: readonly string[];
  devCountry?: string | undefined;
  production: boolean;
}): string {
  const country = input.trustedProxyIps.includes(input.remoteIp) ? input.countryHeader : undefined;
  if (country && /^[A-Z]{2}$/.test(country)) return country;
  return !input.production && input.devCountry ? input.devCountry : "XX";
}

export function eligible(country: string, countries: readonly string[]): boolean {
  return country !== "US" && country !== "XX" && countries.includes(country);
}
