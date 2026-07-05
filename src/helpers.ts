import { z } from "zod";
import type { ResponseDoc } from "./types";

export const messageResponse = (description: string): ResponseDoc => ({
  description,
  schema: z.object({
    message: z.string(),
  }),
});

export const emptyResponse = (description: string): ResponseDoc => ({
  description,
  schema: z.object({}),
});

export const unauthorizedResponse = messageResponse("Authentication is required.");

export const forbiddenResponse = messageResponse("The current user cannot access this resource.");

export const notFoundResponse = messageResponse("The requested resource was not found.");

export const validationErrorResponse: ResponseDoc = {
  description: "The request payload or parameters are invalid.",
  schema: z.object({
    message: z.unknown(),
  }),
};
