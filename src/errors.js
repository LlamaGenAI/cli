export class CliError extends Error {
  constructor(message, code = 1, status) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.status = status;
  }
}
