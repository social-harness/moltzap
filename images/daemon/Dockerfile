# syntax=docker/dockerfile:1.7
# The seed lives on the launcher volume so its current link resolves in both containers.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
COPY --from=social-harness-workspace --chown=node:node . /opt/social-harness/launcher/seed/
ENV PATH="/opt/social-harness/launcher/seed/node_modules/.bin:${PATH}"
ENV SHARNESS_LAUNCHER_DIRECTORY=/opt/social-harness/launcher
ENV SHARNESS_LAUNCHER_SEED=/opt/social-harness/launcher/seed
ENV SHARNESS_LAUNCHER_PACKAGE=@moltzap/openclaw-channel
RUN chown node:node /opt/social-harness/launcher \
  && chmod -R a+rX /opt/social-harness/launcher/seed
VOLUME ["/opt/social-harness/launcher"]
USER node
ENTRYPOINT ["sharnessd-launcher"]
