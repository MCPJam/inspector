import {
  embed,
  LanguageModel,
  TextEmbeddingModel,
  cosineSimilarity,
} from 'ai';
import { MCPResource } from '@/sdk';

/**
 * Generates an embedding for a given string value using the provided model.
 * @param value The string to embed.
 * @param model The language model instance to use for embedding.
 * @returns A promise that resolves to an array of numbers representing the embedding.
 */
export const generateEmbedding = async (
  value: string,
  model: LanguageModel | TextEmbeddingModel<string>,
): Promise<number[]> => {
  const input = value.replaceAll('\n', ' ');
  const { embedding } = await embed({
    model,
    value: input,
  });
  return embedding;
};

/**
 * Finds the most relevant resources from a list based on a user query.
 * @param userQuery The user's query string.
 * @param resources A list of available MCP resources.
 * @param model The language model instance to use for embedding.
 * @param topK The number of top results to return.
 * @returns A promise that resolves to an array of the most relevant resources.
 */
export const findRelevantResources = async (
  userQuery: string,
  resources: MCPResource[],
  model: LanguageModel | TextEmbeddingModel<string>,
  topK: number = 3,
): Promise<MCPResource[]> => {
  console.log(
    `[findRelevantResources] Starting relevance search for query: "${userQuery}"`,
  );
  if (!resources || resources.length === 0) {
    console.log(
      '[findRelevantResources] No resources provided, returning empty array.',
    );
    return [];
  }

  try {
    console.log('[findRelevantResources] Generating embedding for user query...');
    const userQueryEmbedding = await generateEmbedding(userQuery, model);
    console.log(
      '[findRelevantResources] User query embedding generated successfully.',
    );

    const embeddingTimeout = 10000; // 10 seconds
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Resource embedding timed out after ${embeddingTimeout}ms`,
            ),
          ),
        embeddingTimeout,
      ),
    );

    console.log(
      `[findRelevantResources] Generating embeddings for ${resources.length} resources...`,
    );
    const resourcesWithEmbeddings = (await Promise.race([
      Promise.all(
        resources.map(async (resource) => {
          const metadataString = `${resource.name} ${resource.title || ''} ${resource.description || ''}`;
          const embedding = await generateEmbedding(metadataString, model);
          return { ...resource, embedding };
        }),
      ),
      timeoutPromise,
    ])) as (MCPResource & { embedding: number[] })[];

    console.log(
      '[findRelevantResources] Resource embeddings generated successfully.',
    );

    const scoredResources = resourcesWithEmbeddings.map((resource) => ({
      ...resource,
      similarity: cosineSimilarity(userQueryEmbedding, resource.embedding),
    }));

    scoredResources.sort((a, b) => b.similarity - a.similarity);
    console.log('[findRelevantResources] Resources scored and sorted.');

    const topResources = scoredResources.slice(0, topK);
    console.log(
      `[findRelevantResources] Returning top ${topResources.length} relevant resources.`,
    );
    return topResources;
  } catch (error) {
    console.error(
      '[findRelevantResources] An error occurred during relevance search:',
      error,
    );
    return []; // Return empty on error or timeout to prevent hanging
  }
};


