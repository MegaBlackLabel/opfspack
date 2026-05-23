/**
 * Base error class for all OPFS pack operations.
 *
 * All library-specific errors extend `PackError` so consumers can use
 * a single `instanceof` check to distinguish operational failures from
 * generic JavaScript errors.
 */
export class PackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackError'
  }
}

/**
 * Thrown when a pack file uses a format version that the current
 * library does not support.
 */
export class PackVersionError extends PackError {
  constructor(message: string) {
    super(message)
    this.name = 'PackVersionError'
  }
}

/**
 * Thrown when a pack file fails structural or cryptographic validation
 * (e.g. checksum mismatch, truncated data, or invalid magic number).
 */
export class PackCorruptedError extends PackError {
  constructor(message: string) {
    super(message)
    this.name = 'PackCorruptedError'
  }
}

/**
 * Thrown when a requested pack file or entry cannot be found in OPFS
 * or the provided storage handle.
 */
export class PackNotFoundError extends PackError {
  constructor(message: string) {
    super(message)
    this.name = 'PackNotFoundError'
  }
}
