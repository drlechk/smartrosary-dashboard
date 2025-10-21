FROM node:20-alpine
WORKDIR /site
RUN npm i -g live-server@1
USER node
EXPOSE 9999
CMD ["live-server", "--host=0.0.0.0", "--port=9999", "--no-browser", "--wait=150", "/site"]

