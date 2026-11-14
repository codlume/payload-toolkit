import {
  Button,
  ConfirmationModal,
  toast,
  useAuth,
  useConfig,
  useDocumentInfo,
  useForm,
  useModal,
  useTranslation,
} from "@payloadcms/ui";
import { requests } from "@payloadcms/ui/shared";
import { extractID } from "payload/shared";
import React from "react";

import { unpublishErrorOf, unpublishTarget } from "./unpublish-request.ts";

export const UnpublishDocument = () => {
  const {
    id,
    collectionSlug,
    currentEditor,
    data,
    documentIsLocked,
    globalSlug,
    hasPublishedDoc,
    isTrashed,
    setHasPublishedDoc,
    setMostRecentVersionIsAutosaved,
    setUnpublishedVersionCount,
  } = useDocumentInfo();
  const {
    config: {
      routes: { api },
      serverURL,
    },
  } = useConfig();
  const { user } = useAuth();
  const { i18n, t } = useTranslation();
  const { reset } = useForm();
  const { toggleModal } = useModal();
  const target = unpublishTarget({ api, serverURL, collectionSlug, globalSlug, id });
  // Stock hides its menu once the viewer goes read-only on another editor's lock, and the server
  // refuses the request while that lock holds.
  const lockedByOther = documentIsLocked && currentEditor && extractID(currentEditor) !== user?.id;
  if (!hasPublishedDoc || isTrashed || lockedByOther || !target) {
    return null;
  }
  const modalSlug = `roles-unpublish-${collectionSlug ?? globalSlug}-${id ?? ""}`;

  const unpublish = async () => {
    const response = await requests[target.method](target.url, {
      body: JSON.stringify({ _status: "draft" }),
      headers: { "Accept-Language": i18n.language, "Content-Type": "application/json" },
    }).catch(() => null);
    if (response?.status !== 200) {
      const json: unknown = await response?.json().catch(() => null);
      toast.error(unpublishErrorOf(json) ?? t("error:unPublishingDocument"));
      return;
    }
    await reset({ ...data, _status: "draft" });
    toast.success(t("version:unpublishedSuccessfully"));
    setUnpublishedVersionCount(1);
    setMostRecentVersionIsAutosaved(false);
    setHasPublishedDoc(false);
  };

  return (
    <>
      <Button
        buttonStyle="secondary"
        onClick={() => toggleModal(modalSlug)}
        size="medium"
        type="button"
      >
        {t("version:unpublish")}
      </Button>
      <ConfirmationModal
        body={t("version:aboutToUnpublish")}
        confirmingLabel={t("version:unpublishing")}
        heading={t("version:confirmUnpublish")}
        modalSlug={modalSlug}
        onConfirm={unpublish}
      />
    </>
  );
};
