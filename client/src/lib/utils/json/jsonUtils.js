export function getDataType(value) {
    if (Array.isArray(value))
        return "array";
    if (value === null)
        return "null";
    return typeof value;
}
export function tryParseJson(str) {
    const trimmed = str.trim();
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
        !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        return { success: false, data: str };
    }
    try {
        return { success: true, data: JSON.parse(str) };
    }
    catch {
        return { success: false, data: str };
    }
}
/**
 * Updates a value at a specific path in a nested JSON structure
 * @param obj The original JSON value
 * @param path Array of keys/indices representing the path to the value
 * @param value The new value to set
 * @returns A new JSON value with the updated path
 */
export function updateValueAtPath(obj, path, value) {
    if (path.length === 0)
        return value;
    if (obj === null || obj === undefined) {
        obj = !isNaN(Number(path[0])) ? [] : {};
    }
    if (Array.isArray(obj)) {
        return updateArray(obj, path, value);
    }
    else if (typeof obj === "object" && obj !== null) {
        return updateObject(obj, path, value);
    }
    else {
        console.error(`Cannot update path ${path.join(".")} in non-object/array value:`, obj);
        return obj;
    }
}
/**
 * Updates an array at a specific path
 */
function updateArray(array, path, value) {
    const [index, ...restPath] = path;
    const arrayIndex = Number(index);
    if (isNaN(arrayIndex)) {
        console.error(`Invalid array index: ${index}`);
        return array;
    }
    if (arrayIndex < 0) {
        console.error(`Array index out of bounds: ${arrayIndex} < 0`);
        return array;
    }
    let newArray = [];
    for (let i = 0; i < array.length; i++) {
        newArray[i] = i in array ? array[i] : null;
    }
    if (arrayIndex >= newArray.length) {
        const extendedArray = new Array(arrayIndex).fill(null);
        // Copy over the existing elements (now guaranteed to be dense)
        for (let i = 0; i < newArray.length; i++) {
            extendedArray[i] = newArray[i];
        }
        newArray = extendedArray;
    }
    if (restPath.length === 0) {
        newArray[arrayIndex] = value;
    }
    else {
        newArray[arrayIndex] = updateValueAtPath(newArray[arrayIndex], restPath, value);
    }
    return newArray;
}
/**
 * Updates an object at a specific path
 */
function updateObject(obj, path, value) {
    const [key, ...restPath] = path;
    // Validate object key
    if (typeof key !== "string") {
        console.error(`Invalid object key: ${key}`);
        return obj;
    }
    const newObj = { ...obj };
    if (restPath.length === 0) {
        newObj[key] = value;
    }
    else {
        // Ensure key exists
        if (!(key in newObj)) {
            newObj[key] = {};
        }
        newObj[key] = updateValueAtPath(newObj[key], restPath, value);
    }
    return newObj;
}
/**
 * Gets a value at a specific path in a nested JSON structure
 * @param obj The JSON value to traverse
 * @param path Array of keys/indices representing the path to the value
 * @param defaultValue Value to return if path doesn't exist
 * @returns The value at the path, or defaultValue if not found
 */
export function getValueAtPath(obj, path, defaultValue = null) {
    if (path.length === 0)
        return obj;
    const [first, ...rest] = path;
    if (obj === null || obj === undefined) {
        return defaultValue;
    }
    if (Array.isArray(obj)) {
        const index = Number(first);
        if (isNaN(index) || index < 0 || index >= obj.length) {
            return defaultValue;
        }
        return getValueAtPath(obj[index], rest, defaultValue);
    }
    if (typeof obj === "object" && obj !== null) {
        if (!(first in obj)) {
            return defaultValue;
        }
        return getValueAtPath(obj[first], rest, defaultValue);
    }
    return defaultValue;
}
