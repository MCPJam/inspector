FROM mcpjam-harbor-agent:v1
RUN rm /bin/bash && mv /bin/bash.real /bin/bash
COPY . /tests
RUN chmod +x /tests/test.sh
