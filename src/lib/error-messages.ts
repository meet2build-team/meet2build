// The interface is in Bulgarian and the API answers in English (#67).
// Every screen translates API error messages through this one list.
const translations = new Map<string, string>([
  ["Email and password are required", "Попълни имейл и парола."],
  ["Invalid email address", "Имейлът не е валиден."],
  ["Password must be at least 6 characters", "Паролата трябва да е поне 6 знака."],
  ["Password does not meet the requirements", "Паролата не отговаря на изискванията."],
  ["Invalid email or password", "Грешен имейл или парола."],
  ["Email address is not confirmed", "Имейлът още не е потвърден. Провери пощата си за линка."],
  ["Registration is disabled", "Регистрацията в момента е изключена."],
  ["Too many requests", "Твърде много опити. Изчакай малко и опитай пак."],
]);

export function translateApiError(message: unknown) {
  const translated =
    typeof message === "string" ? translations.get(message) : undefined;
  return translated ?? "Нещо се обърка. Опитай пак.";
}