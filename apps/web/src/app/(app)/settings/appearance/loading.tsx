import { Stack } from "@cueplusplus/ui/layout";
import { Spinner } from "@cueplusplus/ui/primitives";

import { Page, PageSection } from "../../../../components/page-layout.js";

export default function AppearanceSettingsLoading() {
  return (
    <Page
      description="Choose the theme, density, and mode this account uses everywhere, and the defaults everyone in the organization inherits."
      eyebrow="Settings"
      title="Appearance"
      width="form"
    >
      <PageSection>
        <Stack align="center" direction="row" gap={2}>
          <Spinner label="Loading appearance settings" size="sm" />
          <span>Loading appearance settings…</span>
        </Stack>
      </PageSection>
    </Page>
  );
}
