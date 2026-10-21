/** An error the API turns into a JSON answer with this HTTP status. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const validationError = (errors) =>
  new AppError(400, 'validation_failed', 'Some fields need attention.', { fields: errors })
