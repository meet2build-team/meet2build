const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

// Checks the email and password in the browser before they are sent.
// Returns the message to show, or null when they can be sent.
export function checkCredentials(email: string, password: string) {
  if (email === "" || password === "") {
    return "Попълни имейл и парола.";
  }
  if (!EMAIL_PATTERN.test(email)) {
    return "Имейлът не е валиден.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return "Паролата трябва да е поне 6 знака.";
  }
  return null;
}