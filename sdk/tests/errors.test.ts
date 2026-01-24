import {
  MCPError,
  MCPAuthError,
  isMCPAuthError,
  isAuthError,
} from "../src/mcp-client-manager/errors";

describe("MCPError", () => {
  it("should create an error with message and code", () => {
    const error = new MCPError("Something went wrong", "SOME_ERROR");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MCPError);
    expect(error.message).toBe("Something went wrong");
    expect(error.code).toBe("SOME_ERROR");
    expect(error.name).toBe("MCPError");
  });

  it("should support cause option", () => {
    const cause = new Error("Original error");
    const error = new MCPError("Wrapped error", "WRAP_ERROR", { cause });

    expect(error.cause).toBe(cause);
  });

  it("should maintain prototype chain for instanceof checks", () => {
    const error = new MCPError("Test", "TEST");

    expect(error instanceof Error).toBe(true);
    expect(error instanceof MCPError).toBe(true);
  });
});

describe("MCPAuthError", () => {
  it("should create an auth error with message and status code", () => {
    const error = new MCPAuthError("Unauthorized access", 401);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MCPError);
    expect(error).toBeInstanceOf(MCPAuthError);
    expect(error.message).toBe("Unauthorized access");
    expect(error.code).toBe("AUTH_ERROR");
    expect(error.statusCode).toBe(401);
    expect(error.name).toBe("MCPAuthError");
  });

  it("should work without status code", () => {
    const error = new MCPAuthError("Auth failed");

    expect(error.statusCode).toBeUndefined();
    expect(error.code).toBe("AUTH_ERROR");
  });

  it("should support cause option", () => {
    const cause = new Error("Token expired");
    const error = new MCPAuthError("Authentication failed", 401, { cause });

    expect(error.cause).toBe(cause);
  });

  it("should work with 403 status code", () => {
    const error = new MCPAuthError("Forbidden", 403);

    expect(error.statusCode).toBe(403);
  });
});

describe("isMCPAuthError", () => {
  it("should return true for MCPAuthError instances", () => {
    const error = new MCPAuthError("Auth error", 401);

    expect(isMCPAuthError(error)).toBe(true);
  });

  it("should return false for regular Error instances", () => {
    const error = new Error("Regular error");

    expect(isMCPAuthError(error)).toBe(false);
  });

  it("should return false for MCPError instances", () => {
    const error = new MCPError("MCP error", "SOME_CODE");

    expect(isMCPAuthError(error)).toBe(false);
  });

  it("should return false for null", () => {
    expect(isMCPAuthError(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isMCPAuthError(undefined)).toBe(false);
  });

  it("should return false for non-error objects", () => {
    expect(isMCPAuthError({ message: "fake error" })).toBe(false);
  });
});

describe("isAuthError", () => {
  describe("non-Error values", () => {
    it("should return { isAuth: false } for null", () => {
      expect(isAuthError(null)).toEqual({ isAuth: false });
    });

    it("should return { isAuth: false } for undefined", () => {
      expect(isAuthError(undefined)).toEqual({ isAuth: false });
    });

    it("should return { isAuth: false } for strings", () => {
      expect(isAuthError("unauthorized")).toEqual({ isAuth: false });
    });

    it("should return { isAuth: false } for plain objects", () => {
      expect(isAuthError({ message: "unauthorized" })).toEqual({
        isAuth: false,
      });
    });
  });

  describe("UnauthorizedError by name", () => {
    it("should detect UnauthorizedError by class name", () => {
      const error = new Error("Access denied");
      error.name = "UnauthorizedError";

      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 401 });
    });
  });

  describe("errors with numeric code property", () => {
    it("should detect 401 status code", () => {
      const error = new Error("HTTP error") as Error & { code: number };
      error.code = 401;

      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 401 });
    });

    it("should detect 403 status code", () => {
      const error = new Error("HTTP error") as Error & { code: number };
      error.code = 403;

      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 403 });
    });

    it("should not detect non-auth status codes", () => {
      const error = new Error("HTTP error") as Error & { code: number };
      error.code = 500;

      expect(isAuthError(error)).toEqual({ isAuth: false });
    });

    it("should not detect 404 as auth error", () => {
      const error = new Error("Not found") as Error & { code: number };
      error.code = 404;

      expect(isAuthError(error)).toEqual({ isAuth: false });
    });
  });

  describe("auth patterns in error messages", () => {
    const authMessages = [
      "Unauthorized access",
      "User is UNAUTHORIZED",
      "invalid_token received",
      "Invalid token provided",
      "Your token expired",
      "The token has expired",
      "Access denied to resource",
      "Authentication failed for user",
      "Authentication required",
      "User is not authenticated",
      "Request forbidden",
    ];

    authMessages.forEach((message) => {
      it(`should detect auth error from message: "${message}"`, () => {
        const error = new Error(message);
        expect(isAuthError(error).isAuth).toBe(true);
      });
    });

    it("should be case-insensitive for pattern matching", () => {
      const error = new Error("UNAUTHORIZED ACCESS");
      expect(isAuthError(error)).toEqual({ isAuth: true });
    });
  });

  describe("HTTP status codes in error messages", () => {
    it("should detect 401 in message with status prefix", () => {
      const error = new Error("Request failed with status: 401");
      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 401 });
    });

    it("should detect HTTP 401 in message", () => {
      const error = new Error("Server returned HTTP 401");
      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 401 });
    });

    it("should detect 403 in message with status prefix", () => {
      const error = new Error("Request failed with status: 403");
      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 403 });
    });

    it("should detect HTTP 403 in message", () => {
      const error = new Error("Server returned HTTP 403");
      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 403 });
    });

    it("should detect standalone 401 in message", () => {
      const error = new Error("Error code 401 from server");
      expect(isAuthError(error)).toEqual({ isAuth: true, statusCode: 401 });
    });
  });

  describe("non-auth errors", () => {
    it("should return { isAuth: false } for regular errors", () => {
      const error = new Error("Something went wrong");
      expect(isAuthError(error)).toEqual({ isAuth: false });
    });

    it("should return { isAuth: false } for network errors", () => {
      const error = new Error("Network connection failed");
      expect(isAuthError(error)).toEqual({ isAuth: false });
    });

    it("should return { isAuth: false } for timeout errors", () => {
      const error = new Error("Request timed out after 30000ms");
      expect(isAuthError(error)).toEqual({ isAuth: false });
    });

    it("should not false-positive on 500 errors", () => {
      const error = new Error("Server returned HTTP 500");
      expect(isAuthError(error)).toEqual({ isAuth: false });
    });

    it("should not false-positive on numbers that contain 401", () => {
      const error = new Error("Invoice #14012 not found");
      // The regex uses word boundary so this should not match
      expect(isAuthError(error)).toEqual({ isAuth: false });
    });
  });
});
