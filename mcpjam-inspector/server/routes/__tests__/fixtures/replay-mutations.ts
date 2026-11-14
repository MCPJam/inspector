import { SYNTHETIC_PII } from "../../../../shared/__tests__/fixtures/telemetry-pii.js";

function pageNode() {
  return {
    type: 0,
    id: 1,
    childNodes: [
      { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
      {
        type: 2,
        id: 3,
        tagName: "html",
        attributes: { lang: "en" },
        childNodes: [
          {
            type: 2,
            id: 4,
            tagName: "head",
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 5,
                tagName: "style",
                attributes: {},
                childNodes: [
                  {
                    type: 3,
                    id: 6,
                    textContent: ".row { color: red; }",
                    isStyle: true,
                  },
                ],
              },
            ],
          },
          {
            type: 2,
            id: 7,
            tagName: "body",
            attributes: { class: "app" },
            childNodes: [
              {
                type: 2,
                id: 8,
                tagName: "h1",
                attributes: {
                  class: "title",
                  title: SYNTHETIC_PII.title,
                  "data-state": "open",
                },
                childNodes: [
                  { type: 3, id: 9, textContent: SYNTHETIC_PII.domText },
                ],
              },
              {
                type: 2,
                id: 10,
                tagName: "input",
                attributes: {
                  type: "text",
                  value: SYNTHETIC_PII.inputValue,
                  placeholder: SYNTHETIC_PII.placeholder,
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 11,
                tagName: "img",
                attributes: {
                  src: SYNTHETIC_PII.imageUrl,
                  alt: SYNTHETIC_PII.name,
                  width: "32",
                  height: "32",
                },
                childNodes: [],
              },
              {
                type: 5,
                id: 12,
                textContent: `owner: ${SYNTHETIC_PII.email}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

export function replayMutationEvents(): unknown[] {
  return [
    {
      type: 4,
      timestamp: 1,
      data: {
        href: `https://app.mcpjam.com/servers/${SYNTHETIC_PII.serverName}`,
        width: 1280,
        height: 800,
      },
    },
    {
      type: 2,
      timestamp: 2,
      data: { node: pageNode(), initialOffset: { top: 0, left: 0 } },
    },
    {
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [{ id: 9, value: SYNTHETIC_PII.name }],
        attributes: [
          { id: 8, attributes: { title: SYNTHETIC_PII.title, class: "big" } },
        ],
        removes: [{ parentId: 7, id: 12 }],
        adds: [
          {
            parentId: 7,
            nextId: null,
            node: { type: 3, id: 13, textContent: SYNTHETIC_PII.email },
          },
          {
            parentId: 5,
            nextId: null,
            node: { type: 3, id: 14, textContent: ".added { margin: 0 }" },
          },
        ],
      },
    },
    {
      type: 3,
      timestamp: 4,
      data: {
        source: 5,
        id: 10,
        text: SYNTHETIC_PII.inputValue,
        isChecked: false,
      },
    },
    {
      type: 3,
      timestamp: 5,
      data: { source: 2, type: 2, id: 10, x: 10, y: 20 },
    },
    {
      type: 3,
      timestamp: 6,
      data: { source: 9, id: 11, type: 0, commands: [] },
    },
    {
      type: 6,
      timestamp: 7,
      data: {
        plugin: "rrweb/console@1",
        payload: { level: "log", payload: [SYNTHETIC_PII.consoleMessage] },
      },
    },
  ];
}
