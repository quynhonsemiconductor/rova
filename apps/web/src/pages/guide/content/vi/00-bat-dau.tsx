/*
 * Vietnamese edition, chapter 00-bat-dau. Converted from the BA's static guide
 * (`public/guide/index.html`); this file is the source of truth now.
 */
import { GuideLink } from '../../ui/guide-link'
import {
  Audience,
  Callout,
  Eyebrow,
  Hero,
  HeroActions,
  HeroButton,
  HeroCopy,
  Lead,
  MetaStrip,
  PathCard,
  PathCopy,
  PathGrid,
  PathIcon,
  PreviewBody,
  PreviewCaption,
  PreviewCards,
  PreviewContext,
  PreviewLogo,
  PreviewTop,
  ReadingFlow,
  ScopePath,
  ScopePreview,
  Section,
  StarterCard,
  StarterGrid,
  StepBadge,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <Hero id="gioi-thieu">
        <HeroCopy>
          <Eyebrow>PHẦN 00 · BẮT ĐẦU</Eyebrow>
          <h1>Làm việc đúng phạm vi ngay từ đầu</h1>
          <Lead>
            Hướng dẫn này giúp bạn tìm đúng Project và Team, tạo và xử lý công việc, theo dõi tiến
            độ, hoặc quản trị Rova theo quyền được cấp.
          </Lead>
          <HeroActions>
            <HeroButton variant="primary" hash="chon-lo-trinh">
              Chọn nội dung cần đọc
            </HeroButton>{' '}
            <HeroButton variant="secondary" hash="truoc-khi-doc">
              Trước khi bắt đầu
            </HeroButton>
          </HeroActions>
        </HeroCopy>
        <ScopePreview aria-label="Minh họa cấu trúc phạm vi Rova">
          <PreviewTop>
            <PreviewLogo>QNSC</PreviewLogo> <PreviewContext>ROVA · TEAM</PreviewContext>
          </PreviewTop>
          <PreviewBody>
            <p>Phạm vi đang chọn</p>
            <ScopePath>
              <span>Workspace</span>
              <b>QNSC</b> <i aria-hidden="true">›</i> <span>Project</span>
              <b>Rova</b> <i aria-hidden="true">›</i> <span>Team</span>
              <b>Team của bạn</b>
            </ScopePath>
            <PreviewCards aria-hidden="true">
              <span>
                <i />
                <i />
                <i />
              </span>{' '}
              <span>
                <i />
                <i />
              </span>
            </PreviewCards>
          </PreviewBody>
          <PreviewCaption>
            Hãy kiểm tra Project và Team trước khi tạo hoặc cập nhật công việc.
          </PreviewCaption>
        </ScopePreview>
      </Hero>
      <MetaStrip aria-label="Thông tin phiên bản tài liệu">
        <div>
          <span>Sản phẩm</span>
          <strong>ROVA</strong>
        </div>
        <div>
          <span>Phiên bản tài liệu</span>
          <strong>1.0</strong>
        </div>
        <div>
          <span>Ngôn ngữ</span>
          <strong>Tiếng Việt / English</strong>
        </div>
        <div>
          <span>Định dạng</span>
          <strong>Hướng dẫn sử dụng</strong>
        </div>
      </MetaStrip>
      <Section
        id="truoc-khi-doc"
        number="00.1"
        title="Trước khi bắt đầu"
        lead="Ba điều giúp bạn tránh thao tác nhầm dữ liệu hoặc tìm sai chức năng."
        prose={false}
      >
        <StarterGrid>
          <StarterCard>
            <StepBadge>1</StepBadge>
            <h3>Kiểm tra phạm vi</h3>
            <p>
              Nhìn góc trên bên trái và xác nhận đúng <strong>Workspace · Project · Team</strong>.
              Danh sách công việc và người có thể chọn phụ thuộc phạm vi này.
            </p>
          </StarterCard>
          <StarterCard>
            <StepBadge>2</StepBadge>
            <h3>Biết quyền của bạn</h3>
            <p>
              Bạn có thể là <strong>Workspace Admin</strong>, <strong>Admin</strong> của Project,
              hoặc <strong>Editor</strong> trong Team. Nút và dữ liệu hiển thị có thể khác nhau.
            </p>
          </StarterCard>
          <StarterCard>
            <StepBadge>3</StepBadge>
            <h3>Chọn đúng mục tiêu</h3>
            <p>
              Đi từ việc bạn muốn hoàn thành: tạo công việc, lập kế hoạch, cập nhật Task, xem báo
              cáo hoặc quản trị. Không cần đọc tuần tự toàn bộ tài liệu.
            </p>
          </StarterCard>
        </StarterGrid>
        <Callout>
          <strong>Lưu ý về quyền</strong>
          <p>
            Vai trò công việc như PM, BA, Developer hoặc QA không phải tên quyền trong Rova. Quyền
            thao tác được xác định theo Workspace, Project và Team.
          </p>
        </Callout>
      </Section>
      <Section
        id="chon-lo-trinh"
        number="00.2"
        title="Chọn lộ trình của bạn"
        lead="Bắt đầu từ công việc bạn cần thực hiện."
        prose={false}
      >
        <PathGrid empty="Không tìm thấy chủ đề phù hợp trong mục lục hiện tại.">
          <PathCard keywords="người mới làm quen truy cập workspace project team đăng nhập">
            <PathIcon tone="blue">01</PathIcon>
            <PathCopy>
              <Audience>TÔI MỚI SỬ DỤNG</Audience>
              <h3>Hiểu hệ thống và vào đúng phạm vi</h3>
              <ul>
                <li>
                  <GuideLink to="01-lam-quen" hash="chapter-01">
                    01. Làm quen với Rova <span>Đọc ngay</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="02-truy-cap-pham-vi" hash="chapter-02">
                    02. Truy cập và chọn phạm vi <span>Đọc ngay</span>
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
          <PathCard keywords="công việc hàng ngày backlog user story defect iteration task team">
            <PathIcon tone="teal">02</PathIcon>
            <PathCopy>
              <Audience>TÔI LÀM VIỆC HẰNG NGÀY</Audience>
              <h3>Tạo, lên kế hoạch và thực hiện công việc</h3>
              <ul>
                <li>
                  <GuideLink to="03-backlog-cong-viec" hash="chapter-03">
                    03. Backlog và tạo công việc <span>Đọc ngay</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="04-testing" hash="chapter-04">
                    04. Testing với Test Case và Result <span>Đọc ngay</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="05-lap-ke-hoach" hash="chapter-05">
                    05. Lập kế hoạch Iteration <span>Đọc ngay</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="06-thuc-hien-cong-viec" hash="chapter-06">
                    06. Thực hiện công việc <span>Đọc ngay</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="07-loi-theo-doi-team" hash="chapter-07">
                    07. Xử lý lỗi và theo dõi Team <span>Đọc ngay</span>
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
          <PathCard keywords="quản lý delivery release milestone portfolio capacity báo cáo">
            <PathIcon tone="violet">03</PathIcon>
            <PathCopy>
              <Audience>TÔI QUẢN LÝ DELIVERY</Audience>
              <h3>Điều phối kế hoạch và đọc tiến độ</h3>
              <ul>
                <li>
                  <GuideLink to="08-release-milestone" hash="chapter-08">
                    08. Release và Milestone
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="09-portfolio-capacity" hash="chapter-09">
                    09. Portfolio và Capacity Planning
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="10-bao-cao" hash="chapter-10">
                    10. Đọc báo cáo
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
          <PathCard keywords="workspace admin quản trị user quyền project team hỗ trợ">
            <PathIcon tone="amber">05</PathIcon>
            <PathCopy>
              <Audience>TÔI QUẢN TRỊ HỆ THỐNG</Audience>
              <h3>Quản lý người dùng và cấu trúc làm việc</h3>
              <ul>
                <li>
                  <GuideLink to="11-quan-tri-workspace" hash="chapter-11">
                    11. Quản trị Workspace
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="12-viet-backlog-item" hash="chapter-12">
                    12. Agile Guideline
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
        </PathGrid>
      </Section>
      <Section
        id="phuong-phap-doc"
        number="00.3"
        title="Cách đọc một bài hướng dẫn"
        lead="Mỗi bài thao tác sau này sẽ dùng cùng một cấu trúc để bạn dễ kiểm tra."
        prose={false}
      >
        <ReadingFlow>
          <li>
            <span>01</span>
            <div>
              <strong>Khi nào dùng</strong>
              <p>Bài này giải quyết việc gì.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Trước khi bắt đầu</strong>
              <p>Quyền và dữ liệu cần có.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Các bước</strong>
              <p>Thao tác ngắn, theo đúng thứ tự.</p>
            </div>
          </li>
          <li>
            <span>05</span>
            <div>
              <strong>Kết quả</strong>
              <p>Cách biết thao tác đã thành công.</p>
            </div>
          </li>
          <li>
            <span>06</span>
            <div>
              <strong>Trường hợp khác</strong>
              <p>Nhánh thường gặp và cách xử lý.</p>
            </div>
          </li>
        </ReadingFlow>
      </Section>
    </>
  )
}
