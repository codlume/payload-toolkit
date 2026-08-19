"use client";

import { FieldLabel, useConfig, useDocumentInfo, useField, usePayloadAPI } from "@payloadcms/ui";
import type { RelationshipFieldClientComponent } from "payload";
import { formatAdminURL } from "payload/shared";
import React, { useMemo } from "react";

const userQuery = { depth: 0 };

const readText = (value: unknown) =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number"
      ? String(value)
      : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentStyle = {
  alignItems: "baseline",
  display: "flex",
  flexWrap: "wrap",
  gap: "calc(var(--base) / 3)",
  minHeight: "1.5rem",
} as const;

type Timestamp = { dateTime: string; label: string } | null;

type LastModifierProps = {
  apiURL: string;
  timestamp: Timestamp;
  useAsTitle: string | undefined;
  userID: string;
  userURL: string;
};

const useLastModifier = ({ apiURL, useAsTitle, userID }: LastModifierProps) => {
  const [{ data: user, isError, isLoading }] = usePayloadAPI(apiURL, {
    initialParams: userQuery,
  });
  const userData = isRecord(user) ? user : {};

  if (isLoading) {
    return null;
  }

  return isError
    ? userID
    : (readText(useAsTitle ? userData[useAsTitle] : undefined) ??
        readText(userData.email) ??
        userID);
};

const LastModifier = (props: LastModifierProps) => {
  const displayName = useLastModifier(props);

  return (
    <>
      {displayName ? <a href={props.userURL}>{displayName}</a> : null}
      {props.timestamp ? (
        <time dateTime={props.timestamp.dateTime}>{props.timestamp.label}</time>
      ) : null}
    </>
  );
};

export const LastModifiedByField: RelationshipFieldClientComponent = ({ path }) => {
  const { value } = useField<unknown>({ path });
  const { config, getEntityConfig } = useConfig();
  const { data: documentData } = useDocumentInfo();
  const userID = readText(value);
  const adminUserCollection = config.admin.user;
  const adminUserConfig = getEntityConfig({ collectionSlug: adminUserCollection });
  const timestamp = useMemo(() => {
    const updatedAt = documentData?.updatedAt;

    if (typeof updatedAt !== "string" && typeof updatedAt !== "number") {
      return null;
    }

    const date = new Date(updatedAt);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return {
      dateTime: date.toISOString(),
      label: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    };
  }, [documentData?.updatedAt]);
  const useAsTitle = adminUserConfig?.admin?.useAsTitle;

  return (
    <div className="activity-field field-type relationship read-only">
      <FieldLabel as="span" label="Last Modified By" path={path} />
      <div data-activity-attribution="" style={contentStyle}>
        {!userID ? (
          <span>—</span>
        ) : (
          <LastModifier
            apiURL={formatAdminURL({
              apiRoute: config.routes.api,
              path: `/${adminUserCollection}/${encodeURIComponent(userID)}`,
              serverURL: config.serverURL,
            })}
            key={userID}
            timestamp={timestamp}
            useAsTitle={useAsTitle}
            userID={userID}
            userURL={formatAdminURL({
              adminRoute: config.routes.admin,
              path: `/collections/${adminUserCollection}/${encodeURIComponent(userID)}`,
              serverURL: config.serverURL,
            })}
          />
        )}
      </div>
    </div>
  );
};
