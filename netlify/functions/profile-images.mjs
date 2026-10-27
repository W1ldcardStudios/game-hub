
import { getStore } from "@netlify/blobs";
import { jwtVerify, createRemoteJWKSet } from "jose";

// =============================================
// WILDCARD STUDIOS — GAME HUB IMAGE BACKEND
// =============================================

const FIREBASE_PROJECT_ID = "gamehub-53ffd";

const SITE_URL = "https://gamehub-images.netlify.app";

const ALLOWED_ORIGINS = [
  "https://himynameishitler.github.io",
  "https://gamehub-images.netlify.app"
];

const firebaseKeys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

// =============================================
// CORS
// =============================================

function cors(origin) {
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  };

  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

// =============================================
// RESPONSE HELPERS
// =============================================

function respond(message, status, origin) {
  return new Response(message, {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

// =============================================
// VERIFY FIREBASE USER
// =============================================

async function verifyUser(request) {
  const header = request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    throw new Error("Missing Firebase login token");
  }

  const token = header.slice(7);

  const { payload } = await jwtVerify(token, firebaseKeys, {
    issuer:
      `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
    algorithms: ["RS256"]
  });

  if (
    typeof payload.sub !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.sub) ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time > Date.now() / 1000
  ) {
    throw new Error("Invalid Firebase user");
  }

  return payload.sub;
}

// =============================================
// MAIN NETLIFY FUNCTION
// =============================================

export default async function handler(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";

  // -------------------------------------------
  // CORS PREFLIGHT
  // -------------------------------------------

  if (request.method === "OPTIONS") {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return respond("Origin not allowed", 403, origin);
    }

    return new Response(null, {
      status: 204,
      headers: cors(origin)
    });
  }

  // -------------------------------------------
  // VALIDATE IMAGE TYPE
  // -------------------------------------------

  const type = url.searchParams.get("type");

  if (!["avatar", "banner"].includes(type)) {
    return respond("Invalid image type", 400, origin);
  }

  const store = getStore("gamehub-profile-images");

  // ===========================================
  // GET — VIEW PROFILE IMAGE
  // ===========================================

  if (request.method === "GET") {
    const uid = url.searchParams.get("uid") || "";

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
      return respond("Invalid user ID", 400, origin);
    }

    const key = `profiles/${uid}/${type}.jpg`;

    try {
      const image = await store.get(key, {
        type: "arrayBuffer"
      });

      if (!image) {
        return respond("Image not found", 404, origin);
      }

      return new Response(image, {
        status: 200,
        headers: {
          ...cors(origin),
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff"
        }
      });

    } catch (err) {
      console.error("Image read failed:", err);

      return respond(
        "Unable to load image",
        500,
        origin
      );
    }
  }

  // ===========================================
  // PUT — UPLOAD PROFILE IMAGE
  // ===========================================

  if (request.method === "PUT") {

    // Check website origin
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return respond(
        "Origin not allowed",
        403,
        origin
      );
    }

    // Verify Firebase login
    let uid;

    try {
      uid = await verifyUser(request);
    } catch (err) {
      console.error("Authentication failed:", err.message);

      return respond(
        "Invalid Firebase login",
        401,
        origin
      );
    }

    // Only accept JPEG uploads
    const contentType = request.headers.get("Content-Type");

    if (contentType !== "image/jpeg") {
      return respond(
        "Only JPEG images allowed",
        415,
        origin
      );
    }

    // Maximum upload size: 2 MB
    const MAX_SIZE = 2 * 1024 * 1024;

    const declaredLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (declaredLength > MAX_SIZE) {
      return respond(
        "Image too large (maximum 2 MB)",
        413,
        origin
      );
    }

    // Read image data
    let data;

    try {
      data = await request.arrayBuffer();
    } catch {
      return respond(
        "Could not read image upload",
        400,
        origin
      );
    }

    if (
      data.byteLength < 4 ||
      data.byteLength > MAX_SIZE
    ) {
      return respond(
        "Invalid image size",
        413,
        origin
      );
    }

    // Validate JPEG signature
    const bytes = new Uint8Array(data);

    const validJPEG =
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9;

    if (!validJPEG) {
      return respond(
        "Invalid JPEG image",
        415,
        origin
      );
    }

    // =========================================
    // SAVE TO NETLIFY BLOBS
    // =========================================

    const key = `profiles/${uid}/${type}.jpg`;

    try {
      await store.set(key, data, {
        metadata: {
          contentType: "image/jpeg",
          type,
          updatedAt: new Date().toISOString()
        }
      });

      const imageURL =
        `${SITE_URL}/.netlify/functions/profile-images` +
        `?uid=${encodeURIComponent(uid)}` +
        `&type=${type}`;

      return jsonResponse(
        {
          success: true,
          uid,
          type,
          imageURL
        },
        200,
        origin
      );

    } catch (err) {
      console.error("Netlify Blobs upload failed:", err);

      return respond(
        "Image storage failed",
        500,
        origin
      );
    }
  }

  // ===========================================
  // UNSUPPORTED METHOD
  // ===========================================

  return respond(
    "Method not allowed",
    405,
    origin
  );
}
