export class UserError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "UserError";
    this.details = details;
  }
}

export function invariant(condition, message, details = undefined) {
  if (!condition) throw new UserError(message, details);
}
